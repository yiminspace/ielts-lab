import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { createApp, parseRange, validProgress } from "../server/index.mjs";
import { loadLibrary, validateArchive } from "../server/library.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ielts-lab-test-"));
  const archive = path.join(root, "archive");
  const organized = path.join(archive, "data/整理");
  const mediaRoot = path.join(archive, "data/media");
  await fs.mkdir(mediaRoot, { recursive: true });
  await fs.mkdir(organized, { recursive: true });
  const mediaRelative = `aa/${"a".repeat(64)}.mp3`;
  await fs.mkdir(path.dirname(path.join(mediaRoot, mediaRelative)), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(mediaRoot, mediaRelative),
    Buffer.from("0123456789"),
  );
  const source = "https://example.invalid/audio.mp3";
  const doc = async (category, name, data, extra = {}) => {
    const dir = path.join(organized, category);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, name + ".json"),
      JSON.stringify({
        title: name,
        category,
        data,
        localMedia: { [source]: "../../media/" + mediaRelative },
        ...extra,
      }),
    );
  };
  await doc("听力", "A local lesson", {
    audioUrl: source,
    questionCount: 1,
    questions: [{ questionCount: 1 }],
    html: `<p><img src="${source}"><img src="https://example.invalid/missing.png"></p>`,
    user: { phone: "private" },
    updateName: "private",
    nested: { token: "secret", useful: true },
  });
  await doc("我的学习", "Private account", { token: "private" });
  await doc("词库", "Words", { items: [{ headWord: "curiosity" }] });
  await doc("发音链接", "Audio", {
    items: [
      {
        manifestType: "word",
        targetId: "curiosity",
        accent: "bf_emma",
        audioUrl: source,
      },
    ],
  });
  await doc("打字练习", "Typing", [
    { title: "Original one", content: "One" },
    { title: "Original two", content: "Two" },
  ]);
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(root, "dist/index.html"),
    "<h1>Original test app</h1>",
  );
  await fs.writeFile(
    path.join(root, "config.local.json"),
    JSON.stringify({ archiveRoot: archive }),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, archive, mediaRoot, mediaRelative };
}
async function running(t, options) {
  const app = await createApp(options);
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        app.server.closeAllConnections();
        app.server.close(resolve);
      }),
  );
  const url = `http://127.0.0.1:${app.server.address().port}`;
  return { ...app, url };
}
function rawRequest(url, route, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      { host: parsed.hostname, port: parsed.port, path: route, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}
const progress = {
  updatedAt: "2026-10-18T01:00:01Z",
  attempts: [
    {
      id: "attempt-1",
      itemId: "demo-listening",
      title: "Demo",
      kind: "listening",
      createdAt: "2026-10-18T01:00:00Z",
      score: 3,
      total: 4,
      answers: { 1: "Monday" },
    },
  ],
  bookmarks: ["demo-listening"],
  drafts: { note: { text: "A local draft" } },
  notes: { lesson: "A local note" },
};

test("demo is original, includes every supported kind, and can be forced over configuration", async (t) => {
  const fixtureData = await fixture(t);
  const library = await loadLibrary({
    forceDemo: true,
    archiveRoot: fixtureData.archive,
  });
  assert.equal(library.mode, "demo");
  assert.equal(library.publicLibrary.items.length, 10);
  assert.equal(
    new Set(library.publicLibrary.items.map((item) => item.kind)).size,
    10,
  );
  assert.equal(
    (await library.getItem("demo-listening")).data.audioUrl,
    "/media/demo-listening.wav",
  );
  assert.equal(await library.getItem("missing"), null);
});

test("archive indexing allowlists study categories and rewrites local media without exposing identity metadata", async (t) => {
  const { archive } = await fixture(t);
  const library = await loadLibrary({ archiveRoot: archive });
  assert.equal(library.publicLibrary.items.length, 4);
  assert.equal(library.publicLibrary.counts.typing, 2);
  assert.ok(
    !library.publicLibrary.items.some(
      (item) => item.title === "Private account",
    ),
  );
  const ref = library.publicLibrary.items.find(
    (item) => item.kind === "listening",
  );
  const item = await library.getItem(ref.id);
  assert.match(item.data.audioUrl, /^\/media\/aa\//);
  assert.ok(item.data.html.includes("/media/aa/"));
  assert.ok(!item.data.html.includes("example.invalid"));
  assert.equal(item.data.user, undefined);
  assert.equal(item.data.updateName, undefined);
  assert.equal(item.data.nested.token, undefined);
  assert.equal(item.data.nested.useful, true);
  const words = await library.getItem(
    library.publicLibrary.items.find((item) => item.kind === "vocabulary").id,
  );
  assert.match(words.data.items[0].audioUrls.bf_emma, /^\/media\//);
});

test("range parsing rejects malformed, multiple, empty and unsafe numeric ranges", () => {
  assert.deepEqual(parseRange("bytes=2-5", 10), { start: 2, end: 5 });
  assert.deepEqual(parseRange("bytes=8-", 10), { start: 8, end: 9 });
  assert.deepEqual(parseRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange("bytes=0-999", 10), { start: 0, end: 9 });
  for (const header of [
    "items=0-1",
    "bytes=",
    "bytes=-",
    "bytes=-0",
    "bytes=10-",
    "bytes=5-2",
    "bytes=1-2,4-5",
    "bytes=9007199254740992-",
    "bytes= 0-2",
  ])
    assert.equal(parseRange(header, 10), false, header);
  assert.equal(parseRange("bytes=0-", 0), false);
  assert.equal(parseRange(undefined, 10), null);
});

test("media supports byte ranges, suffix ranges, HEAD and 416 for seeking", async (t) => {
  const f = await fixture(t);
  const app = await running(t, { projectRoot: f.root });
  const media = app.url + "/media/" + f.mediaRelative;
  const partial = await fetch(media, { headers: { Range: "bytes=2-5" } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(await partial.text(), "2345");
  const suffix = await fetch(media, { headers: { Range: "bytes=-2" } });
  assert.equal(await suffix.text(), "89");
  const head = await fetch(media, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "10");
  assert.equal(await head.text(), "");
  const invalid = await fetch(media, { headers: { Range: "bytes=11-" } });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get("content-range"), "bytes */10");
});

test("traversal, symlink escape, unknown files and arbitrary remote proxy requests fail", async (t) => {
  const f = await fixture(t);
  const app = await running(t, { projectRoot: f.root });
  for (const route of [
    "/media/../config.local.json",
    "/media/%2e%2e/config.local.json",
    "/media/%2e%2e%5cconfig.local.json",
    "/%00",
    "/.local/progress-archive.json",
  ]) {
    const result = await rawRequest(app.url, route);
    assert.ok([403, 404].includes(result.status), route);
  }
  assert.equal(
    (await fetch(app.url + "/media/http://example.invalid/audio.mp3")).status,
    404,
  );
  assert.equal(
    (await fetch(app.url + "/media/aa/" + "b".repeat(64) + ".mp3")).status,
    404,
  );
  const outside = path.join(f.root, "outside.txt");
  await fs.writeFile(outside, "secret");
  await fs.unlink(path.join(f.mediaRoot, f.mediaRelative));
  await fs.symlink(outside, path.join(f.mediaRoot, f.mediaRelative));
  assert.equal(
    (await fetch(app.url + "/media/" + f.mediaRelative)).status,
    403,
  );
});

test("origin and Host checks reject cross-site writes and DNS rebinding", async (t) => {
  const f = await fixture(t);
  const app = await running(t, { projectRoot: f.root });
  const denied = await fetch(app.url + "/api/progress", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://attacker.invalid",
    },
    body: JSON.stringify(progress),
  });
  assert.equal(denied.status, 403);
  assert.equal(
    (await rawRequest(app.url, "/api/library", { Host: "attacker.invalid" }))
      .status,
    403,
  );
  const value = await (await fetch(app.url + "/api/progress")).json();
  assert.equal(value.attempts.length, 0);
});

test("progress validation, atomic persistence, and mode separation", async (t) => {
  const f = await fixture(t);
  const app = await running(t, { projectRoot: f.root });
  const put = async (body) =>
    fetch(app.url + "/api/progress", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: app.url },
      body: JSON.stringify(body),
    });
  assert.equal((await put(progress)).status, 200);
  assert.deepEqual(
    await (await fetch(app.url + "/api/progress")).json(),
    progress,
  );
  assert.deepEqual(
    JSON.parse(await fs.readFile(app.progressFile, "utf8")),
    progress,
  );
  const stale = {
    ...progress,
    updatedAt: "2026-10-18T00:00:01Z",
    notes: { lesson: "stale" },
  };
  assert.equal((await put(stale)).status, 409);
  const withoutTime = { ...progress };
  delete withoutTime.updatedAt;
  assert.equal((await put(withoutTime)).status, 409);
  const newer = {
    ...progress,
    updatedAt: "2026-10-18T01:00:02Z",
    notes: { lesson: "newer" },
  };
  const responses = await Promise.all([put(newer), put(stale)]);
  assert.equal(responses[0].status, 200);
  assert.equal(responses[1].status, 409);
  assert.deepEqual(
    await (await fetch(app.url + "/api/progress")).json(),
    newer,
  );
  assert.equal((await put({ ...progress, attempts: "invalid" })).status, 400);
  assert.equal(
    (await put({ ...progress, notes: { x: "a".repeat(5 * 1024 * 1024) } }))
      .status,
    413,
  );
  assert.equal((await fs.stat(app.progressFile)).mode & 0o777, 0o600);
  const demo = await running(t, { projectRoot: f.root, forceDemo: true });
  assert.deepEqual(await (await fetch(demo.url + "/api/progress")).json(), {
    attempts: [],
    bookmarks: [],
    drafts: {},
    notes: {},
  });
  assert.ok(demo.progressFile.endsWith("progress-demo.json"));
});

test("progress schema rejects prototype keys and invalid attempts", () => {
  assert.equal(validProgress(progress), true);
  assert.equal(validProgress({ ...progress, updatedAt: "invalid" }), false);
  assert.equal(
    validProgress(
      JSON.parse(
        '{"attempts":[],"bookmarks":[],"drafts":{"__proto__":{}},"notes":{}}',
      ),
    ),
    false,
  );
  assert.equal(
    validProgress({
      ...progress,
      attempts: [{ ...progress.attempts[0], createdAt: "not-a-date" }],
    }),
    false,
  );
  assert.equal(
    validProgress({
      ...progress,
      attempts: [{ ...progress.attempts[0], score: -1 }],
    }),
    false,
  );
  assert.equal(validProgress({ ...progress, notes: { x: 2 } }), false);
});

test("production serves only dist and demo assets; forced demo does not load archive material", async (t) => {
  const f = await fixture(t);
  const app = await running(t, { projectRoot: f.root, forceDemo: true });
  assert.match(await (await fetch(app.url + "/")).text(), /Original test app/);
  assert.equal((await fetch(app.url + "/config.local.json")).status, 404);
  assert.equal(
    (await fetch(app.url + "/media/" + f.mediaRelative)).status,
    404,
  );
  const asset = await fetch(app.url + "/media/demo-listening.wav");
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("content-type"), "audio/wav");
  assert.equal((await fetch(app.url + "/api/items/unknown")).status, 404);
  assert.equal(
    (await fetch(app.url + "/api/library", { method: "POST" })).status,
    405,
  );
});

test("an archive cannot redirect its media directory outside the chosen root", async (t) => {
  const f = await fixture(t);
  await fs.rm(f.mediaRoot, { recursive: true });
  await fs.symlink(f.root, f.mediaRoot);
  await assert.rejects(() => validateArchive(f.archive));
});
