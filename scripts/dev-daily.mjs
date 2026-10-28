import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (
  !process.env.IELTS_RUNTIME_TOKEN ||
  process.env.IELTS_RUNTIME_TOKEN.length < 32
) {
  console.error(
    "请先在 .local/learning.env 配置 IELTS_RUNTIME_TOKEN（至少 32 字符）和模型设置。",
  );
  process.exit(1);
}
const runtimePort = process.env.IELTS_RUNTIME_PORT || "4320";
const env = {
  ...process.env,
  IELTS_RUNTIME_URL:
    process.env.IELTS_RUNTIME_URL || `http://127.0.0.1:${runtimePort}`,
  RUNTIME_DATABASE: path.join(root, ".local/learning/runtime.sqlite"),
};
const children = [
  spawn(
    "uv",
    [
      "run",
      "--project",
      "services/learning",
      "--locked",
      "--no-dev",
      "python",
      "-m",
      "ielts_learning",
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...env, HOST: "127.0.0.1", PORT: runtimePort },
    },
  ),
  spawn(process.execPath, ["scripts/dev.mjs", ...process.argv.slice(2)], {
    cwd: root,
    stdio: "inherit",
    env,
  }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children)
    if (child.exitCode === null) child.kill("SIGTERM");
  const timer = setTimeout(() => {
    for (const child of children)
      if (child.exitCode === null) child.kill("SIGKILL");
    process.exit(code);
  }, 12000);
  Promise.all(
    children.map((child) =>
      child.exitCode === null
        ? new Promise((resolve) => child.once("exit", resolve))
        : Promise.resolve(),
    ),
  ).then(() => {
    clearTimeout(timer);
    process.exit(code);
  });
}
for (const child of children) {
  child.on("error", () => {
    console.error("学习服务启动失败，请检查 uv 和模型配置。");
    stop(1);
  });
  child.on("exit", (code) => {
    if (!stopping) stop(code || 0);
  });
}
process.on("SIGTERM", () => stop());
process.on("SIGINT", () => stop());
