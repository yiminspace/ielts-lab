import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { createApp } from "../services/api/index.mjs";
import { createAuth } from "../services/api/auth.mjs";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const origin = "https://ielts.example.invalid";
function environment(root) {
  return {
    NODE_ENV: "production",
    IELTS_AUTH_REQUIRED: "1",
    OWNER_USER_ID: owner,
    SESSION_SECRET: "synthetic-session-secret-for-tests-only",
    PUBLIC_ORIGIN: origin,
    AUTHKIT_API_URL: "https://auth.example.invalid",
    RECORDINGS_ROOT: path.join(root, "recordings"),
  };
}
async function running(t, { verifyIdentity, clock } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ielts-auth-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = {
    getProgress: async (id) => ({
      attempts: [],
      drafts: {},
      notes: {},
      bookmarks: [],
      sync: {
        protocol: "entities-v1",
        userId: id,
        revisions: { drafts: {}, notes: {}, bookmarks: {}, settings: {} },
      },
    }),
  };
  const app = await createApp({
    projectRoot: root,
    forceDemo: true,
    env: environment(root),
    store,
    verifyIdentity:
      verifyIdentity ||
      (async (token) => ({
        id: token === "owner" ? owner : other,
        expiresAt: (clock?.() ?? Date.now()) + 60000,
      })),
    now: clock,
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
  const request = (route, options = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        base + route,
        {
          method: options.method || "GET",
          headers: {
            Host: "ielts.example.invalid",
            ...(options.method && options.method !== "GET"
              ? { Origin: origin }
              : {}),
            ...options.headers,
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
      req.end(options.body);
    });
  return { ...app, request, base };
}

test("production authentication fails closed on absent or unsafe configuration", () => {
  const env = environment("/synthetic");
  assert.throws(
    () => createAuth({ env: { NODE_ENV: "production" } }),
    /IELTS_AUTH_REQUIRED/,
  );
  for (const name of [
    "OWNER_USER_ID",
    "SESSION_SECRET",
    "PUBLIC_ORIGIN",
    "AUTHKIT_API_URL",
  ])
    assert.throws(() => createAuth({ env: { ...env, [name]: "" } }));
  assert.throws(
    () =>
      createAuth({
        env: { ...env, PUBLIC_ORIGIN: "http://ielts.example.invalid" },
      }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      createAuth({
        env: { ...env, AUTHKIT_API_URL: "https://auth.example.invalid/path" },
      }),
    /origin/,
  );
});

test("public health/config leak no identity and private routes reject missing cookies and header spoofing", async (t) => {
  const { request, base } = await running(t);
  assert.equal((await fetch(base + "/health")).status, 200);
  const config = await (await request("/api/config")).json();
  assert.deepEqual(Object.keys(config).sort(), [
    "authRequired",
    "authkitApiUrl",
    "publicOrigin",
  ]);
  assert.equal(config.authRequired, true);
  assert.equal(JSON.stringify(config).includes(owner), false);
  for (const route of [
    "/api/progress",
    "/api/library",
    "/api/papers",
    "/api/items/demo-speaking",
    "/media/demo-listening.wav",
    "/recordings/private.wav",
    "/api/recordings",
  ]) {
    assert.equal(
      (
        await request(route, {
          headers: { "X-User-ID": owner, Authorization: "Bearer owner" },
        })
      ).status,
      401,
      route,
    );
  }
  assert.equal(
    (await request("/api/config", { headers: { Host: "evil.invalid" } }))
      .status,
    403,
  );
  assert.equal(
    (
      await request("/api/config", {
        headers: { Origin: "https://evil.invalid" },
      })
    ).status,
    403,
  );
});

test("owner exchange uses secure HttpOnly cookie; another authenticated user cannot enter", async (t) => {
  const { request } = await running(t);
  assert.equal(
    (
      await request("/api/auth/session", {
        method: "POST",
        headers: { Authorization: "Bearer other" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await request("/api/auth/session", { method: "POST" })).status,
    401,
  );
  assert.equal(
    (
      await request("/api/auth/session", {
        method: "POST",
        headers: {
          Authorization: "Bearer owner",
          Origin: "https://evil.invalid",
        },
      })
    ).status,
    403,
  );
  const logged = await request("/api/auth/session", {
    method: "POST",
    headers: { Authorization: "Bearer owner" },
  });
  assert.equal(logged.status, 200);
  const setCookie = logged.headers.get("set-cookie");
  assert.match(setCookie, /^__Host-ielts-session=/);
  for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"])
    assert.ok(setCookie.includes(flag));
  const Cookie = setCookie.split(";")[0];
  assert.equal(
    (await request("/api/progress", { headers: { Cookie } })).status,
    200,
  );
  const protectedMedia = await request("/media/demo-listening.wav", {
    headers: { Cookie, Range: "bytes=0-3" },
  });
  assert.equal(protectedMedia.status, 206);
  assert.match(protectedMedia.headers.get("cache-control"), /no-store/);
  assert.deepEqual(
    (await (await request("/api/auth/me", { headers: { Cookie } })).json())
      .user,
    { id: owner },
  );
  assert.equal(
    (await request("/api/progress", { headers: { Cookie: Cookie + "x" } }))
      .status,
    401,
  );
  assert.equal(
    (
      await request("/api/progress", {
        method: "PUT",
        headers: { Cookie, "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    405,
  );
  assert.equal(
    (await request("/api/auth/logout", { method: "POST", headers: { Cookie } }))
      .status,
    200,
  );
  assert.equal(
    (await request("/api/progress", { headers: { Cookie } })).status,
    401,
  );
});

test("cookie expiry cannot outlive the verified AuthKit token", async (t) => {
  let time = Date.now();
  const { request } = await running(t, {
    clock: () => time,
    verifyIdentity: async () => ({ id: owner, expiresAt: time + 2000 }),
  });
  const logged = await request("/api/auth/session", {
    method: "POST",
    headers: { Authorization: "Bearer owner" },
  });
  const Cookie = logged.headers.get("set-cookie").split(";")[0];
  assert.match(logged.headers.get("set-cookie"), /Max-Age=2/);
  time += 2001;
  assert.equal(
    (await request("/api/auth/me", { headers: { Cookie } })).status,
    401,
  );
});

test("session exchange validates a bearer with AuthKit and requires verified identity to match JWT subject", async (t) => {
  const token = (sub) =>
    `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url")}.synthetic`;
  const good = token(owner),
    wrongSubject = token(other);
  let requiredScope;
  const upstream = http.createServer((req, res) => {
    requiredScope = req.headers["x-required-scope"];
    if (
      ![good, wrongSubject].some(
        (value) => req.headers.authorization === `Bearer ${value}`,
      )
    ) {
      res.writeHead(401);
      res.end();
      return;
    }
    res.writeHead(200, { "X-User-ID": owner });
    res.end();
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        upstream.closeAllConnections();
        upstream.close(resolve);
      }),
  );
  const auth = createAuth({
    env: {
      ...environment("/synthetic"),
      AUTHKIT_API_URL: `http://127.0.0.1:${upstream.address().port}`,
    },
    allowInsecureTest: true,
  });
  const req = (value) => ({
    headers: { authorization: `Bearer ${value}` },
    socket: { remoteAddress: "127.0.0.1" },
  });
  let cookie;
  const response = {
    setHeader: (_name, value) => {
      cookie = value;
    },
  };
  assert.deepEqual((await auth.exchange(req(good), response)).user, {
    id: owner,
  });
  assert.equal(requiredScope, "__full__");
  assert.match(cookie, /^__Host-ielts-session=/);
  await assert.rejects(auth.exchange(req(wrongSubject), response), {
    status: 401,
  });
  await assert.rejects(auth.exchange(req("unverified"), response), {
    status: 401,
  });
});

test("a rejected account switch invalidates the previous owner cookie server-side", async (t) => {
  const { request } = await running(t);
  const response = await request("/api/auth/session", {
    method: "POST",
    headers: { Authorization: "Bearer owner" },
  });
  const Cookie = response.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (await request("/api/progress", { headers: { Cookie } })).status,
    200,
  );
  const switched = await request("/api/auth/session", {
    method: "POST",
    headers: { Cookie, Authorization: "Bearer other" },
  });
  assert.equal(switched.status, 403);
  assert.match(switched.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal(
    (await request("/api/progress", { headers: { Cookie } })).status,
    401,
  );
});
