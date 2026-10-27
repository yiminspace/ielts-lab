import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { createApp } from "../services/api/index.mjs";
import { migrate } from "../services/api/scripts/migrate.mjs";
import { provisionDatabase } from "../services/api/scripts/provision-db.mjs";

const adminURL = process.env.IELTS_TEST_ADMIN_DATABASE_URL;
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const origin = "https://ielts.example.invalid";

test(
  "service HTTP: owner auth, entity CAS/import, recordings and PostgreSQL survive server restart",
  { skip: !adminURL },
  async (t) => {
    const { Client } = await import("pg");
    const suffix = `http_${process.pid}_${Date.now()}`;
    const db = `ielts_${suffix}`,
      runtimeRole = `ielts_app_${suffix}`,
      migrationRole = `ielts_migrate_${suffix}`;
    const makeURL = (name) => {
      const url = new URL(adminURL);
      url.username = name;
      url.password = "local-original-test-only";
      url.pathname = `/${db}`;
      return url.toString();
    };
    const runtimeURL = makeURL(runtimeRole),
      migrationURL = makeURL(migrationRole);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ielts-pg-http-"));
    const admin = new Client({ connectionString: adminURL });
    await admin.connect();
    const runningApps = [];
    async function stop(app) {
      if (app.server.listening)
        await new Promise((resolve) => {
          app.server.closeAllConnections();
          app.server.close(resolve);
        });
      await app.store.close();
    }
    t.after(async () => {
      for (const app of runningApps) await stop(app);
      await admin.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
      for (const role of [runtimeRole, migrationRole])
        await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.end();
      await fs.rm(root, { recursive: true, force: true });
    });
    await provisionDatabase({ adminURL, migrationURL, runtimeURL });
    await migrate({ connectionString: migrationURL, runtimeRole });
    async function start() {
      const app = await createApp({
        projectRoot: root,
        forceDemo: true,
        env: {
          NODE_ENV: "production",
          IELTS_AUTH_REQUIRED: "1",
          OWNER_USER_ID: owner,
          SESSION_SECRET: "synthetic-session-secret-for-test-only",
          PUBLIC_ORIGIN: origin,
          AUTHKIT_API_URL: "https://auth.example.invalid",
          RECORDINGS_ROOT: path.join(root, "recordings"),
          DATABASE_URL: runtimeURL,
        },
        verifyIdentity: async () => ({
          id: owner,
          expiresAt: Date.now() + 60000,
        }),
      });
      await new Promise((resolve) =>
        app.server.listen(0, "127.0.0.1", resolve),
      );
      runningApps.push(app);
      const base = `http://127.0.0.1:${app.server.address().port}`;
      const request = (route, { method = "GET", headers = {}, body } = {}) =>
        new Promise((resolve, reject) => {
          const req = http.request(
            base + route,
            {
              method,
              headers: {
                Host: "ielts.example.invalid",
                ...(method !== "GET" && method !== "HEAD"
                  ? { Origin: origin }
                  : {}),
                ...headers,
              },
            },
            (res) => {
              const chunks = [];
              res.on("data", (part) => chunks.push(part));
              res.on("end", () =>
                resolve(
                  new Response(Buffer.concat(chunks), {
                    status: res.statusCode,
                    headers: Object.fromEntries(
                      Object.entries(res.headers).map(([k, v]) => [
                        k,
                        Array.isArray(v) ? v.join(", ") : v,
                      ]),
                    ),
                  }),
                ),
              );
            },
          );
          req.on("error", reject);
          req.end(body);
        });
      const login = await request("/api/auth/session", {
        method: "POST",
        headers: { Authorization: "Bearer owner" },
      });
      assert.equal(login.status, 200);
      const Cookie = login.headers.get("set-cookie").split(";")[0];
      const json = (route, method, value) => {
        const body = JSON.stringify(value);
        return request(route, {
          method,
          headers: {
            Cookie,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
          body,
        });
      };
      return { app, request, json, Cookie };
    }
    let app = await start();
    const noteURL =
      "/api/progress/notes/" + encodeURIComponent("demo-speaking");
    assert.equal(
      (
        await app.json(noteURL, "PUT", {
          value: "original note",
          expectedVersion: 0,
        })
      ).status,
      200,
    );
    const conflict = await app.json(noteURL, "PUT", {
      value: "stale",
      expectedVersion: 0,
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).currentVersion, 1);
    assert.equal(
      (
        await app.json("/api/progress/settings/track", "PUT", {
          value: "general",
          expectedVersion: 0,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await app.json(
          "/api/progress/drafts/" + encodeURIComponent("paper:original"),
          "PUT",
          { value: { activeSection: 1 }, expectedVersion: 0 },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await app.json("/api/progress/bookmarks/deleted", "DELETE", {
          expectedVersion: 0,
        })
      ).status,
      200,
    );
    const attempt = {
      id: "original-attempt",
      itemId: "demo-speaking",
      title: "Original speaking",
      kind: "speaking",
      createdAt: new Date().toISOString(),
      durationSeconds: 2,
    };
    assert.equal(
      (await (await app.json("/api/attempts", "POST", attempt)).json()).created,
      true,
    );
    assert.equal(
      (await (await app.json("/api/attempts", "POST", attempt)).json()).created,
      false,
    );
    assert.equal(
      (
        await app.json("/api/attempts", "POST", {
          ...attempt,
          durationSeconds: 3,
        })
      ).status,
      409,
    );
    const imported = {
      progress: {
        attempts: [attempt],
        drafts: { additional: { text: "backup" } },
        notes: { "demo-speaking": "stale backup" },
        bookmarks: ["deleted"],
        settings: {},
      },
      merge: true,
    };
    assert.equal(
      (await app.json("/api/progress/import", "POST", imported)).status,
      200,
    );
    assert.equal(
      Object.values(
        (
          await (
            await app.json("/api/progress/import", "POST", imported)
          ).json()
        ).imported,
      ).reduce((a, b) => a + b, 0),
      0,
    );
    const upload = await app.request(
      "/api/recordings?itemId=demo-speaking&question=0&durationSeconds=2",
      {
        method: "POST",
        headers: { Cookie: app.Cookie, "Content-Type": "audio/mp4" },
        body: "original recording bytes",
      },
    );
    assert.equal(upload.status, 201);
    const recording = await upload.json();
    assert.equal(recording.contentType, "audio/mp4");
    const oldCookie = app.Cookie;
    await stop(app.app);
    app = await start();
    assert.equal(
      (await app.request("/api/progress", { headers: { Cookie: oldCookie } }))
        .status,
      401,
    );
    const progress = await (
      await app.request("/api/progress", { headers: { Cookie: app.Cookie } })
    ).json();
    assert.equal(progress.sync.userId, owner);
    assert.equal(progress.sync.protocol, "entities-v1");
    assert.equal(progress.notes["demo-speaking"], "original note");
    assert.equal(progress.sync.revisions.notes["demo-speaking"], 1);
    assert.equal(progress.settings.track, "general");
    assert.deepEqual(progress.drafts["paper:original"], { activeSection: 1 });
    assert.deepEqual(progress.bookmarks, []);
    assert.equal(progress.attempts.length, 1);
    assert.deepEqual(progress.drafts.additional, { text: "backup" });
    const list = await (
      await app.request("/api/recordings?itemId=demo-speaking", {
        headers: { Cookie: app.Cookie },
      })
    ).json();
    assert.equal(list.recordings.length, 1);
    const audio = await app.request(recording.audioUrl, {
      headers: { Cookie: app.Cookie, Range: "bytes=0-7" },
    });
    assert.equal(audio.status, 206);
    assert.equal(await audio.text(), "original");
    assert.equal(
      (
        await app.request(`/api/recordings/${recording.id}`, {
          method: "DELETE",
          headers: { Cookie: app.Cookie },
        })
      ).status,
      200,
    );
  },
);
