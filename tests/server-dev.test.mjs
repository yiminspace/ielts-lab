import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setTimeout(200);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}
async function waitUntil(check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  do {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return false;
}
test(
  "development runner honors configured ports and terminates both child servers on SIGTERM",
  { timeout: 15000 },
  async (t) => {
    const port = await freePort();
    let apiPort = await freePort();
    while (apiPort === port) apiPort = await freePort();
    const child = spawn(process.execPath, ["scripts/dev.mjs", "--demo"], {
      cwd: root,
      env: { ...process.env, PORT: String(port), API_PORT: String(apiPort) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGTERM");
    });
    assert.ok(
      await waitUntil(
        async () => (await canConnect(port)) && (await canConnect(apiPort)),
      ),
      output,
    );
    const library = await (
      await fetch(`http://127.0.0.1:${port}/api/library`)
    ).json();
    assert.equal(library.mode, "demo");
    assert.equal(library.items.length, 17);
    const exit = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    assert.equal(await exit, 0);
    assert.ok(
      await waitUntil(
        async () => !(await canConnect(port)) && !(await canConnect(apiPort)),
        3000,
      ),
    );
  },
);
