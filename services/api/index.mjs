import http from "node:http";
import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { inside, loadLibrary } from "./library.mjs";
import { createAuth } from "./auth.mjs";
import { createRecordings, createLocalRecordingStore } from "./recordings.mjs";
import { createDaily } from "./daily.mjs";

const moduleRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
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
        ![
          "attempts",
          "bookmarks",
          "drafts",
          "notes",
          "settings",
          "updatedAt",
        ].includes(key),
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
  if (value.settings !== undefined && !isObject(value.settings)) return false;
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
async function streamFile(
  req,
  res,
  root,
  file,
  { rejectSymlinks = false, contentType, noStore = false } = {},
) {
  const realRoot = await fs.realpath(root);
  const realFile = await fs.realpath(file);
  if (!inside(realRoot, realFile))
    throw Object.assign(new Error("文件不在允许目录中"), { status: 403 });
  if (
    rejectSymlinks &&
    ((await fs.lstat(file)).isSymbolicLink() || realFile !== path.resolve(file))
  )
    throw Object.assign(new Error("录音文件不被允许"), { status: 403 });
  // Open first and stat the descriptor: a replacement symlink cannot redirect a read.
  const handle = await fs.open(
    realFile,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let streaming = false;
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      throw Object.assign(new Error("文件不存在"), { status: 404 });
    const range = parseRange(req.headers.range, stat.size);
    const headers = {
      "Content-Type":
        contentType ||
        mime[path.extname(realFile).toLowerCase()] ||
        "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Cache-Control": noStore ? "private, no-store" : "private, max-age=3600",
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
    const start = range ? range.start : 0,
      end = range ? range.end : stat.size - 1;
    headers["Content-Length"] = range ? end - start + 1 : stat.size;
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === "HEAD" || stat.size === 0) {
      res.end();
      return;
    }
    const stream = handle.createReadStream({ start, end, autoClose: true });
    streaming = true;
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  } finally {
    if (!streaming) await handle.close();
  }
}

export async function createApp({
  projectRoot = moduleRoot,
  archiveRoot,
  forceDemo = false,
  dev = false,
  frontendPort = 4317,
  env = process.env,
  store: suppliedStore,
  verifyIdentity,
  now,
  allowInsecureTest = false,
  runtimeClient,
  dailyPollInterval,
} = {}) {
  const auth = createAuth({ env, verifyIdentity, now, allowInsecureTest });
  if (auth.required && !env.DATABASE_URL && !suppliedStore)
    throw new Error("服务模式必须配置 DATABASE_URL");
  if (!forceDemo && archiveRoot === undefined) {
    archiveRoot = env.ARCHIVE_ROOT;
    if (!archiveRoot) {
      try {
        const config = JSON.parse(
          await fs.readFile(
            path.join(projectRoot, "config.local.json"),
            "utf8",
          ),
        );
        archiveRoot = config.archiveRoot;
        if (typeof archiveRoot !== "string" || !path.isAbsolute(archiveRoot))
          throw new Error("config.local.json 的 archiveRoot 必须是绝对路径");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  if (auth.required && !env.RECORDINGS_ROOT)
    throw new Error("服务模式必须配置 RECORDINGS_ROOT");
  const library = await loadLibrary({ archiveRoot, forceDemo });
  let store = suppliedStore;
  if (!store && env.DATABASE_URL) {
    const { PostgresStore } = await import("./postgres.mjs");
    store = new PostgresStore({
      connectionString: env.DATABASE_URL,
      ownerUserId: auth.ownerUserId,
    });
  }
  try {
    if (store?.init) await store.init();
    if (store?.syncLibrary)
      await store.syncLibrary(
        library.mode,
        library.publicLibrary.items,
        await library.getPapers(),
      );
  } catch (error) {
    await store?.close?.();
    throw error;
  }
  const progressFile = path.join(
    projectRoot,
    ".local",
    `progress-${library.mode}.json`,
  );
  const recordingsRoot =
    env.RECORDINGS_ROOT || path.join(projectRoot, ".local", "recordings");
  const recordings = createRecordings({
    root: recordingsRoot,
    store: store || createLocalRecordingStore(recordingsRoot),
    mode: library.mode,
    library,
  });
  const daily = createDaily({
    library,
    store,
    root: env.DAILY_ROOT || path.join(projectRoot, ".local", "daily"),
    env,
    ownerId: auth.ownerUserId,
    runtimeClient,
    pollInterval: dailyPollInterval,
  });
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
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    // AuthKit sends bearer credentials only from browser code to its configured API.
    const authConnect = auth.required ? ` ${auth.authkitApiUrl}` : "";
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'${authConnect}; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
    );
    try {
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
      auth.checkRequest(req, {
        publicHealth: route === "/health",
        dev,
        frontendPort,
      });
      const read = req.method === "GET" || req.method === "HEAD";
      if (read && route === "/health")
        return sendJSON(
          res,
          200,
          { status: "ok", service: "ielts-api", version: env.GIT_SHA || "dev" },
          req.method === "HEAD",
        );
      if (read && route === "/api/config")
        return sendJSON(res, 200, auth.publicConfig, req.method === "HEAD");
      if (req.method === "POST" && route === "/api/auth/session")
        return sendJSON(res, 200, await auth.exchange(req, res));
      if (req.method === "POST" && route === "/api/auth/logout")
        return sendJSON(res, 200, auth.logout(req, res));
      const protectedRoute =
        route.startsWith("/api/") ||
        route.startsWith("/media/") ||
        route === "/recordings" ||
        route.startsWith("/recordings/");
      const user = protectedRoute ? auth.requireUser(req) : null;
      if (read && route === "/api/daily")
        return sendJSON(
          res,
          200,
          await daily.list(user.id),
          req.method === "HEAD",
        );
      const dailyAudio =
        /^\/api\/daily\/(daily-[a-f0-9]{40})\/recordings\/((?:recording|teacher)-[a-f0-9]{32})\/audio$/.exec(
          route,
        );
      if (dailyAudio && read) {
        const file = await daily.audio(user.id, dailyAudio[1], dailyAudio[2]);
        return streamFile(req, res, file.directory, file.target, {
          rejectSymlinks: true,
          contentType: file.metadata.contentType,
          noStore: true,
        });
      }
      const dailyUpload =
        /^\/api\/daily\/(daily-[a-f0-9]{40})\/recordings$/.exec(route);
      if (dailyUpload && req.method === "POST")
        return sendJSON(
          res,
          202,
          await daily.upload(
            user.id,
            dailyUpload[1],
            req,
            new URL(req.url, "http://local.invalid"),
          ),
        );
      const dailyRoute =
        /^\/api\/daily\/(daily-[a-f0-9]{40})(?:\/(retry|reading|conversation|conversation-state|recognition-error|expression-help|writing|draft|speech))?$/.exec(
          route,
        );
      if (dailyRoute) {
        if (read && !dailyRoute[2])
          return sendJSON(
            res,
            200,
            await daily.get(user.id, dailyRoute[1]),
            req.method === "HEAD",
          );
        if (req.method === "POST" && dailyRoute[2]) {
          const value = await daily.action(
            user.id,
            dailyRoute[1],
            dailyRoute[2],
            await readJSONBody(req),
          );
          return sendJSON(
            res,
            ["conversation", "expression-help", "writing"].includes(
              dailyRoute[2],
            )
              ? 202
              : 200,
            value,
          );
        }
        return sendJSON(res, 405, { error: "此操作不被支持" });
      }
      if (read && route === "/api/auth/me")
        return sendJSON(
          res,
          200,
          { user: { id: user.id }, expiresAt: user.expiresAt || null },
          req.method === "HEAD",
        );
      if (req.method === "PUT" && route === "/api/progress") {
        if (store)
          return sendJSON(res, 405, {
            error: "服务模式使用逐项同步，不能覆盖整份记录",
          });
        const value = await readJSONBody(req);
        if (!validProgress(value))
          return sendJSON(res, 400, { error: "学习记录结构不正确" });
        const operation = writeQueue.then(async () => {
          const existing = await readProgressDisk();
          if (
            existing.updatedAt &&
            (!value.updatedAt ||
              Date.parse(value.updatedAt) < Date.parse(existing.updatedAt))
          )
            throw Object.assign(new Error("记录已更新，请刷新后重试"), {
              status: 409,
            });
          await atomicJSON(progressFile, value);
          const newAttemptsHeader = req.headers["x-ielts-new-attempts"];
          const submittedIds = new Set(
            typeof newAttemptsHeader === "string" &&
              newAttemptsHeader.length <= 10000
              ? newAttemptsHeader.split(",")
              : [],
          );
          for (const attempt of value.attempts)
            if (attempt.kind === "listening" && submittedIds.has(attempt.id))
              await daily.ensure(user.id, attempt).catch(() => {
                throw Object.assign(
                  new Error("作答已保存，听后练习暂未入队；请保留页面等待重试"),
                  { status: 503 },
                );
              });
        });
        writeQueue = operation.catch(() => {});
        await operation;
        return sendJSON(res, 200, { ok: true });
      }
      const entity =
        /^\/api\/progress\/(drafts|notes|bookmarks|settings|practice_sessions)\/(.+)$/.exec(
          route,
        );
      if (entity && ["PUT", "DELETE"].includes(req.method)) {
        if (!store)
          return sendJSON(res, 409, { error: "本地模式使用学习记录文件" });
        const body = await readJSONBody(req),
          [, bucket, id] = entity;
        if (
          !shortString(id, 500) ||
          !id ||
          !isObject(body) ||
          !Number.isSafeInteger(body.expectedVersion) ||
          body.expectedVersion < 0 ||
          !cleanJSON(body) ||
          (req.method === "PUT" && !("value" in body))
        )
          return sendJSON(res, 400, { error: "记录内容或版本不正确" });
        if (
          req.method === "PUT" &&
          ((bucket === "notes" && !shortString(body.value, 200000)) ||
            (bucket === "bookmarks" && typeof body.value !== "boolean"))
        )
          return sendJSON(res, 400, { error: "记录类型不正确" });
        return sendJSON(
          res,
          200,
          await store.setEntity(
            user.id,
            library.mode,
            bucket,
            id,
            body,
            req.method === "DELETE",
          ),
        );
      }
      if (req.method === "POST" && route === "/api/attempts") {
        if (!store)
          return sendJSON(res, 409, { error: "本地模式使用学习记录文件" });
        const attempt = await readJSONBody(req);
        if (!validProgress({ ...emptyProgress(), attempts: [attempt] }))
          return sendJSON(res, 400, { error: "作答记录格式不正确" });
        return sendJSON(
          res,
          200,
          await store.addAttempt(
            user.id,
            library.mode,
            attempt,
            await daily.seed(user.id, attempt),
          ),
        );
      }
      if (req.method === "POST" && route === "/api/progress/import") {
        if (!store)
          return sendJSON(res, 409, { error: "本地模式请使用页面记录导入" });
        const body = await readJSONBody(req);
        if (!isObject(body) || body.merge !== true || !isObject(body.progress))
          return sendJSON(res, 400, {
            error: "导入必须使用保留现有记录的合并模式",
          });
        const { attempts, bookmarks, drafts, notes, updatedAt, settings } =
          body.progress;
        const progress = {
          attempts,
          bookmarks,
          drafts,
          notes,
          ...(updatedAt === undefined ? {} : { updatedAt }),
        };
        if (
          !validProgress(progress) ||
          (settings !== undefined &&
            (!isObject(settings) || !cleanJSON(settings)))
        )
          return sendJSON(res, 400, { error: "学习记录结构不正确" });
        return sendJSON(
          res,
          200,
          await store.importProgress(user.id, library.mode, {
            ...progress,
            settings: settings || {},
          }),
        );
      }
      if (route === "/api/recordings" && req.method === "POST")
        return sendJSON(
          res,
          201,
          await recordings.upload(
            req,
            user.id,
            new URL(req.url, "http://local.invalid"),
          ),
        );
      if (route === "/api/recordings" && read)
        return sendJSON(
          res,
          200,
          await recordings.list(
            user.id,
            new URL(req.url, "http://local.invalid").searchParams.get(
              "itemId",
            ) || undefined,
          ),
          req.method === "HEAD",
        );
      const recordingAudio = /^\/api\/recordings\/([a-f0-9-]+)\/audio$/.exec(
        route,
      );
      if (recordingAudio && read) {
        const file = await recordings.audio(user.id, recordingAudio[1]);
        return await streamFile(req, res, file.directory, file.target, {
          rejectSymlinks: true,
          contentType: file.metadata.contentType,
          noStore: true,
        });
      }
      const recordingId = /^\/api\/recordings\/([a-f0-9-]+)$/.exec(route);
      if (recordingId && req.method === "DELETE")
        return sendJSON(
          res,
          200,
          await recordings.remove(user.id, recordingId[1]),
        );
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
      if (route === "/api/progress") {
        if (store)
          return sendJSON(
            res,
            200,
            await store.getProgress(user.id, library.mode),
            req.method === "HEAD",
          );
        await writeQueue;
        return sendJSON(
          res,
          200,
          await readProgressDisk(),
          req.method === "HEAD",
        );
      }
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
      if (
        route.startsWith("/api/") ||
        route === "/recordings" ||
        route.startsWith("/recordings/")
      )
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
            path.join(moduleRoot, "services/api/assets"),
            path.join(moduleRoot, "services/api/assets", relative),
            { noStore: auth.required },
          );
        if (!library.mediaRoot || !library.allowedMedia.has(relative))
          return sendJSON(res, 404, { error: "本地媒体不存在" });
        return await streamFile(
          req,
          res,
          library.mediaRoot,
          path.join(library.mediaRoot, relative),
          { noStore: auth.required },
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
            ? "读取或保存失败，请检查服务配置。"
            : error.status
              ? error.message
              : "文件不存在",
        ...(Number.isInteger(error.currentVersion)
          ? { currentVersion: error.currentVersion }
          : {}),
      });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.on("close", () => {
    auth.close();
    void daily
      .close()
      .then(() => store?.close?.())
      .catch(() => {});
  });
  return { server, library, progressFile, store, daily };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const dev = process.argv.includes("--api");
  const port = Number(
    dev
      ? process.env.API_PORT || process.env.PORT || 4318
      : process.env.PORT || 4318,
  );
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("端口不正确");
  const host = process.env.HOST || "127.0.0.1";
  if (
    host !== "127.0.0.1" &&
    host !== "localhost" &&
    process.env.IELTS_AUTH_REQUIRED !== "1"
  )
    throw new Error("非本机监听必须启用权限控制");
  const { server, library, daily, store } = await createApp({
    forceDemo:
      process.argv.includes("--demo") || process.env.IELTS_DEMO === "1",
    dev,
    frontendPort: Number(process.env.FRONTEND_PORT || 4317),
  });
  server.listen(port, host, () =>
    console.log(
      `IELTS Lab ${library.mode}: port ${port} · ${library.publicLibrary.items.length} items`,
    ),
  );
  const stop = () => {
    server.close(() => {
      void daily
        .close()
        .then(() => store?.close?.())
        .finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
