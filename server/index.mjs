import http from "node:http";
import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { inside, loadLibrary } from "./library.mjs";

const moduleRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAX_BODY = 5 * 1024 * 1024;
const emptyProgress = () => ({
  attempts: [],
  bookmarks: [],
  drafts: {},
  notes: {},
});
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".mpga": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".webm": "video/webm",
  ".woff2": "font/woff2",
};
const kinds = new Set([
  "listening",
  "reading",
  "writing",
  "speaking",
  "vocabulary",
  "sentences",
  "grammar",
  "numbers",
  "typing",
  "courses",
]);
const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const shortString = (value, max = 1000) =>
  typeof value === "string" && value.length <= max;
function cleanJSON(value, depth = 0) {
  if (depth > 40) return false;
  if (Array.isArray(value))
    return value.every((child) => cleanJSON(child, depth + 1));
  if (isObject(value))
    return Object.entries(value).every(
      ([key, child]) =>
        !["__proto__", "constructor", "prototype"].includes(key) &&
        cleanJSON(child, depth + 1),
    );
  return (
    value === null || ["string", "number", "boolean"].includes(typeof value)
  );
}
export function validProgress(value) {
  if (
    !isObject(value) ||
    !cleanJSON(value) ||
    Object.keys(value).some(
      (key) =>
        !["attempts", "bookmarks", "drafts", "notes", "updatedAt"].includes(
          key,
        ),
    )
  )
    return false;
  if (
    value.updatedAt !== undefined &&
    (!shortString(value.updatedAt, 100) ||
      !Number.isFinite(Date.parse(value.updatedAt)))
  )
    return false;
  if (
    !Array.isArray(value.attempts) ||
    value.attempts.length > 10000 ||
    !Array.isArray(value.bookmarks) ||
    value.bookmarks.length > 20000
  )
    return false;
  if (
    !value.bookmarks.every((id) => shortString(id, 200)) ||
    !isObject(value.drafts) ||
    !isObject(value.notes)
  )
    return false;
  if (!Object.values(value.notes).every((note) => shortString(note, 200000)))
    return false;
  return value.attempts.every(
    (attempt) =>
      isObject(attempt) &&
      shortString(attempt.id, 200) &&
      shortString(attempt.itemId, 200) &&
      shortString(attempt.title) &&
      kinds.has(attempt.kind) &&
      shortString(attempt.createdAt, 100) &&
      Number.isFinite(Date.parse(attempt.createdAt)) &&
      ["score", "total", "durationSeconds"].every(
        (key) =>
          attempt[key] === undefined ||
          (Number.isFinite(attempt[key]) && attempt[key] >= 0),
      ) &&
      (attempt.detail === undefined || shortString(attempt.detail, 200000)) &&
      (attempt.answers === undefined ||
        (isObject(attempt.answers) &&
          Object.values(attempt.answers).every(
            (answer) =>
              shortString(answer, 100000) ||
              (Array.isArray(answer) &&
                answer.every((item) => shortString(item, 100000))),
          ))),
  );
}
export function parseRange(header, size) {
  if (typeof header !== "string") return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) return false;
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start >= size ||
      start > end
    )
      return false;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}
async function atomicJSON(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporary, target);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}
function sendJSON(res, status, value, head = false) {
  const content = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(content),
    "Cache-Control": "no-store",
  });
  res.end(head ? undefined : content);
}
async function readJSONBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || ""))
    throw Object.assign(new Error("需要 application/json"), { status: 415 });
  if (Number(req.headers["content-length"]) > MAX_BODY)
    throw Object.assign(new Error("学习记录超过 5 MB 限制"), { status: 413 });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY)
      throw Object.assign(new Error("学习记录超过 5 MB 限制"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("JSON 格式不正确"), { status: 400 });
  }
}
async function streamFile(req, res, root, file) {
  const realRoot = await fs.realpath(root);
  const realFile = await fs.realpath(file);
  if (!inside(realRoot, realFile))
    throw Object.assign(new Error("文件不在允许目录中"), { status: 403 });
  const stat = await fs.stat(realFile);
  if (!stat.isFile())
    throw Object.assign(new Error("文件不存在"), { status: 404 });
  const range = parseRange(req.headers.range, stat.size);
  const headers = {
    "Content-Type":
      mime[path.extname(realFile).toLowerCase()] || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    "Last-Modified": stat.mtime.toUTCString(),
  };
  if (range === false) {
    res.writeHead(416, {
      ...headers,
      "Content-Range": `bytes */${stat.size}`,
      "Content-Length": 0,
    });
    res.end();
    return;
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : stat.size - 1;
  headers["Content-Length"] = range ? end - start + 1 : stat.size;
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === "HEAD" || stat.size === 0) {
    res.end();
    return;
  }
  const stream = createReadStream(realFile, { start, end });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

export async function createApp({
  projectRoot = moduleRoot,
  archiveRoot,
  forceDemo = false,
  dev = false,
  frontendPort = 4317,
} = {}) {
  if (!forceDemo && archiveRoot === undefined) {
    try {
      const config = JSON.parse(
        await fs.readFile(path.join(projectRoot, "config.local.json"), "utf8"),
      );
      archiveRoot = config.archiveRoot;
      if (typeof archiveRoot !== "string" || !path.isAbsolute(archiveRoot))
        throw new Error("config.local.json 的 archiveRoot 必须是绝对路径");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const library = await loadLibrary({ archiveRoot, forceDemo });
  const progressFile = path.join(
    projectRoot,
    ".local",
    `progress-${library.mode}.json`,
  );
  let writeQueue = Promise.resolve();
  async function readProgressDisk() {
    try {
      const value = JSON.parse(await fs.readFile(progressFile, "utf8"));
      if (!validProgress(value)) throw new Error("本地学习记录格式损坏");
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return emptyProgress();
      throw error;
    }
  }
  async function getProgress() {
    await writeQueue;
    return readProgressDisk();
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    try {
      const host = req.headers.host || "";
      if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(host))
        return sendJSON(res, 403, { error: "仅允许本机访问" });
      let route;
      try {
        route = decodeURIComponent((req.url || "/").split("?")[0]);
      } catch {
        return sendJSON(res, 400, { error: "路径编码不正确" });
      }
      if (
        route.includes("\\") ||
        route.includes("\0") ||
        route.split("/").some((segment) => segment === ".." || segment === ".")
      )
        return sendJSON(res, 403, { error: "路径不被允许" });
      const read = req.method === "GET" || req.method === "HEAD";
      if (req.method === "PUT" && route === "/api/progress") {
        const allowedOrigins = new Set([`http://${host}`]);
        if (dev) {
          allowedOrigins.add(`http://127.0.0.1:${frontendPort}`);
          allowedOrigins.add(`http://localhost:${frontendPort}`);
        }
        const origin = req.headers.origin;
        if (
          (origin && !allowedOrigins.has(origin)) ||
          (!origin && req.headers["sec-fetch-site"] === "cross-site")
        )
          return sendJSON(res, 403, { error: "拒绝跨站写入学习记录" });
        const value = await readJSONBody(req);
        if (!validProgress(value))
          return sendJSON(res, 400, { error: "学习记录结构不正确" });
        const operation = writeQueue.then(async () => {
          const existing = await readProgressDisk();
          if (
            existing.updatedAt &&
            (!value.updatedAt ||
              Date.parse(value.updatedAt) < Date.parse(existing.updatedAt))
          ) {
            throw Object.assign(new Error("记录已更新，请刷新后重试"), {
              status: 409,
            });
          }
          await atomicJSON(progressFile, value);
        });
        writeQueue = operation.catch(() => {});
        await operation;
        return sendJSON(res, 200, { ok: true });
      }
      if (!read) return sendJSON(res, 405, { error: "此操作不被支持" });
      if (route === "/api/library")
        return sendJSON(res, 200, library.publicLibrary, req.method === "HEAD");
      if (route === "/api/papers")
        return sendJSON(
          res,
          200,
          { papers: await library.getPapers() },
          req.method === "HEAD",
        );
      if (route.startsWith("/api/papers/")) {
        const id = route.slice("/api/papers/".length);
        if (!/^[a-z0-9-]{1,100}$/.test(id))
          return sendJSON(res, 400, { error: "试卷 ID 不正确" });
        const paper = await library.getPaper(id);
        return sendJSON(
          res,
          paper ? 200 : 404,
          paper || { error: "试卷不存在" },
          req.method === "HEAD",
        );
      }
      if (route === "/api/progress")
        return sendJSON(res, 200, await getProgress(), req.method === "HEAD");
      if (route.startsWith("/api/items/")) {
        const id = route.slice("/api/items/".length);
        if (!/^[a-z0-9-]{1,100}$/.test(id))
          return sendJSON(res, 400, { error: "材料 ID 不正确" });
        const item = await library.getItem(id);
        return sendJSON(
          res,
          item ? 200 : 404,
          item || { error: "材料不存在" },
          req.method === "HEAD",
        );
      }
      if (route.startsWith("/api/"))
        return sendJSON(res, 404, { error: "接口不存在" });
      if (route.startsWith("/media/")) {
        const relative = route.slice("/media/".length);
        if (
          (relative === "demo-listening.wav" || library.mode === "demo") &&
          (/^demo-(?:listening|number|word-[0-3]|sentence-[0-2]|speaking-[0-2])\.wav$/.test(
            relative,
          ) ||
            ["demo-slide.svg", "demo-course.mp4"].includes(relative))
        )
          return await streamFile(
            req,
            res,
            path.join(moduleRoot, "server/assets"),
            path.join(moduleRoot, "server/assets", relative),
          );
        if (!library.mediaRoot || !library.allowedMedia.has(relative))
          return sendJSON(res, 404, { error: "本地媒体不存在" });
        return await streamFile(
          req,
          res,
          library.mediaRoot,
          path.join(library.mediaRoot, relative),
        );
      }
      const dist = path.join(projectRoot, "dist");
      const relative = route.replace(/^\/+/, "");
      if (relative.split("/").some((segment) => segment.startsWith(".")))
        return sendJSON(res, 404, { error: "文件不存在" });
      let target = path.join(dist, relative || "index.html");
      if (!inside(dist, target))
        return sendJSON(res, 403, { error: "路径不被允许" });
      try {
        await fs.access(target);
      } catch {
        if (path.extname(relative))
          return sendJSON(res, 404, { error: "文件不存在" });
        target = path.join(dist, "index.html");
      }
      await streamFile(req, res, dist, target);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = error.status || (error.code === "ENOENT" ? 404 : 500);
      sendJSON(res, status, {
        error:
          status === 500
            ? "本地读取失败，请检查归档路径或学习记录文件。"
            : error.status
              ? error.message
              : "本地文件不存在",
      });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return { server, library, progressFile };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const dev = process.argv.includes("--api");
  const port = Number(
    dev ? process.env.API_PORT || 4318 : process.env.PORT || 4317,
  );
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("端口不正确");
  const { server, library } = await createApp({
    forceDemo:
      process.argv.includes("--demo") || process.env.IELTS_DEMO === "1",
    dev,
    frontendPort: Number(process.env.PORT || 4317),
  });
  server.listen(port, "127.0.0.1", () =>
    console.log(
      `IELTS Lab ${library.mode}: http://127.0.0.1:${port} · ${library.publicLibrary.items.length} items`,
    ),
  );
  const stop = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
