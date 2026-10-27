import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children)
    if (child.exitCode === null) child.kill("SIGTERM");
  const timeout = setTimeout(() => {
    for (const child of children)
      if (child.exitCode === null) child.kill("SIGKILL");
    process.exit(code);
  }, 2000);
  Promise.all(
    children.map((child) =>
      child.exitCode === null
        ? new Promise((resolve) => child.once("exit", resolve))
        : Promise.resolve(),
    ),
  ).then(() => {
    clearTimeout(timeout);
    process.exit(code);
  });
}
const api = spawn(
  process.execPath,
  [path.join(root, "services/api/index.mjs"), "--api", ...args],
  { cwd: root, stdio: "inherit", env: process.env },
);
children.push(api);
const vite = spawn(
  process.execPath,
  [
    path.join(root, "node_modules/vite/bin/vite.js"),
    "--host",
    "127.0.0.1",
    "--port",
    process.env.PORT || "4317",
  ],
  { cwd: root, stdio: "inherit", env: process.env },
);
children.push(vite);
for (const child of children) {
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("exit", (code) => {
    if (!stopping) stop(code || 0);
  });
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
