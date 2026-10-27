import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionFetch } from "../apps/web/src/lib/session-fetch.mjs";

test("renews once for simultaneous expired requests and preserves each retry body", async () => {
  let renewed = false,
    renewals = 0;
  const bodies = [];
  const request = createSessionFetch({
    origin: "https://ielts.example",
    fetch: async (value) => {
      bodies.push(await value.text());
      return new Response("{}", { status: renewed ? 200 : 401 });
    },
    renew: async () => {
      renewals++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      renewed = true;
      return true;
    },
    denied: () => assert.fail("unexpected denial"),
  });
  const responses = await Promise.all(
    ["one", "two"].map((body) =>
      request("/api/progress", { method: "PUT", body }),
    ),
  );
  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200],
  );
  assert.equal(renewals, 1);
  assert.deepEqual(bodies.sort(), ["one", "one", "two", "two"]);
});

test("external and authentication requests never trigger session renewal", async () => {
  const request = createSessionFetch({
    origin: "https://ielts.example",
    fetch: async () => new Response(null, { status: 401 }),
    renew: () => assert.fail("must not renew"),
    denied: () => assert.fail("unexpected denial"),
  });
  assert.equal((await request("https://auth.example/api/auth/me")).status, 401);
  assert.equal((await request("/api/auth/session")).status, 401);
});

test("denial is forwarded to the access boundary and unsuccessful renewal is not retried", async () => {
  let calls = 0,
    denials = 0;
  const request = createSessionFetch({
    origin: "https://ielts.example",
    fetch: async () => {
      calls++;
      return new Response(null, { status: calls === 1 ? 401 : 403 });
    },
    renew: async () => false,
    denied: () => denials++,
  });
  assert.equal((await request("/api/progress")).status, 401);
  assert.equal(calls, 1);
  assert.equal((await request("/api/library")).status, 403);
  assert.equal(denials, 1);
});
