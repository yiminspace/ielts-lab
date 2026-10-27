import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { createApp } from "../services/api/index.mjs";

async function running(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ielts-recording-test-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const recordingsRoot = path.join(root, "recordings");
  const app = await createApp({
    projectRoot: root,
    forceDemo: true,
    env: { RECORDINGS_ROOT: recordingsRoot },
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        app.server.closeAllConnections();
        app.server.close(resolve);
      }),
  );
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (route, options) => fetch(base + route, options);
  const upload = (body = "original synthetic audio bytes", options = {}) =>
    request(
      "/api/recordings?itemId=demo-speaking&question=0&durationSeconds=1.5",
      {
        method: "POST",
        headers: {
          "Content-Type": "audio/webm;codecs=opus",
          ...options.headers,
        },
        body,
      },
    );
  return { ...app, root, recordingsRoot, request, upload, base };
}

test("recordings persist metadata and opaque files, stream Range/HEAD, and delete without a public uploads route", async (t) => {
  const { request, upload, recordingsRoot } = await running(t);
  const response = await upload();
  assert.equal(response.status, 201);
  const saved = await response.json();
  assert.match(saved.id, /^[a-f0-9-]{36}$/);
  assert.equal(saved.itemId, "demo-speaking");
  assert.equal(saved.question, 0);
  assert.equal(saved.contentType, "audio/webm");
  assert.equal(saved.filename, undefined);
  assert.equal(saved.userId, undefined);
  assert.equal(
    (await fs.readdir(recordingsRoot)).some((f) => f.endsWith(".upload")),
    false,
  );
  assert.deepEqual(
    (await (await request("/api/recordings?itemId=demo-speaking")).json())
      .recordings,
    [saved],
  );
  assert.deepEqual(
    (await (await request("/api/recordings?itemId=other")).json()).recordings,
    [],
  );
  const partial = await request(saved.audioUrl, {
    headers: { Range: "bytes=0-7" },
  });
  assert.equal(partial.status, 206);
  assert.equal(await partial.text(), "original");
  assert.equal(partial.headers.get("cache-control"), "private, no-store");
  const head = await request(saved.audioUrl, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal((await request(`/recordings/${saved.id}.webm`)).status, 404);
  assert.equal(
    (await request(`/api/recordings/${saved.id}`, { method: "DELETE" })).status,
    200,
  );
  assert.equal((await request(saved.audioUrl)).status, 404);
  assert.deepEqual(
    (await (await request("/api/recordings")).json()).recordings,
    [],
  );
  assert.deepEqual(await fs.readdir(recordingsRoot), ["index.json"]);
});

test("upload validates type, item, question and byte limit before committing metadata", async (t) => {
  const { request, upload, recordingsRoot, base } = await running(t);
  assert.equal(
    (await upload("x", { headers: { "Content-Type": "text/html" } })).status,
    415,
  );
  assert.equal((await upload("")).status, 400);
  assert.equal(
    (
      await request(
        "/api/recordings?itemId=demo-reading&question=0&durationSeconds=1",
        {
          method: "POST",
          headers: { "Content-Type": "audio/webm" },
          body: "x",
        },
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        "/api/recordings?itemId=demo-speaking&question=-1&durationSeconds=1",
        {
          method: "POST",
          headers: { "Content-Type": "audio/webm" },
          body: "x",
        },
      )
    ).status,
    400,
  );
  const oversized = await new Promise((resolve, reject) => {
    const req = http.request(
      base +
        "/api/recordings?itemId=demo-speaking&question=0&durationSeconds=1",
      {
        method: "POST",
        headers: {
          "Content-Type": "audio/webm",
          "Content-Length": 32 * 1024 * 1024 + 1,
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(oversized, 413);
  assert.deepEqual(
    (await (await request("/api/recordings")).json()).recordings,
    [],
  );
  assert.deepEqual(await fs.readdir(recordingsRoot), []);
});

test("recording reads reject replacement symlinks, and upload rejects a symlink root", async (t) => {
  const { request, upload, recordingsRoot, root } = await running(t);
  const saved = await (await upload()).json();
  const target = path.join(recordingsRoot, saved.id + ".webm");
  const outside = path.join(root, "outside.webm");
  await fs.writeFile(outside, "private outside bytes");
  await fs.unlink(target);
  await fs.symlink(outside, target);
  assert.equal((await request(saved.audioUrl)).status, 403);
  assert.equal(
    (await request(`/api/recordings/${saved.id}`, { method: "DELETE" })).status,
    403,
  );
  assert.equal(await fs.readFile(outside, "utf8"), "private outside bytes");
  await fs.rm(recordingsRoot, { recursive: true });
  const otherDirectory = path.join(root, "other-recordings");
  await fs.mkdir(otherDirectory);
  await fs.symlink(otherDirectory, recordingsRoot);
  assert.equal((await upload()).status, 403);
  assert.deepEqual(await fs.readdir(otherDirectory), []);
});
