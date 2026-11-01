import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import { spawn } from "node:child_process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

test("Web health identifies its own revision independently of API routing", async (t) => {
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const sha = "a".repeat(40);
  const server = spawn(process.execPath, ["deploy/web-server.mjs"], {
    env: { HOST: "127.0.0.1", PORT: String(port), GIT_SHA: sha },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (server.exitCode === null) {
      server.kill();
      await once(server, "exit");
    }
  });
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/web-health`);
      ready = response.ok;
      if (ready) break;
    } catch {
      // The child may not have bound the socket yet.
    }
    await delay(50);
  }
  assert.ok(ready, "Web server must become ready");
  for (const route of ["/health", "/web-health"]) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      status: "ok",
      service: "ielts-web",
      version: sha,
    });
  }
});
