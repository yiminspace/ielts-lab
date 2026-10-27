import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const MAX_RECORDING = 32 * 1024 * 1024;
const types = new Map([
  ["audio/webm", "webm"],
  ["audio/ogg", "ogg"],
  ["audio/mp4", "m4a"],
  ["audio/mpeg", "mp3"],
  ["audio/wav", "wav"],
  ["audio/x-wav", "wav"],
]);
const fail = (status, message) => Object.assign(new Error(message), { status });
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const publicRecording = ({ filename, userId, mode, ...metadata }) => ({
  ...metadata,
  audioUrl: `/api/recordings/${metadata.id}/audio`,
});
export function createRecordings({ root, store, mode, library }) {
  if (!path.isAbsolute(root)) throw new Error("RECORDINGS_ROOT 必须是绝对路径");
  async function safeRoot() {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(root)).isSymbolicLink())
      throw fail(403, "录音目录不能是符号链接");
    return fs.realpath(root);
  }
  async function safeFile(metadata) {
    if (
      !UUID.test(metadata.id) ||
      !/^[a-f0-9-]{36}\.(webm|ogg|m4a|mp3|wav)$/.test(metadata.filename)
    )
      throw fail(404, "录音不存在");
    const directory = await safeRoot();
    const target = path.join(directory, metadata.filename);
    const stat = await fs.lstat(target);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      (await fs.realpath(target)) !== target
    )
      throw fail(403, "录音文件不被允许");
    return { directory, target };
  }
  return {
    async upload(req, userId, url) {
      const itemId = url.searchParams.get("itemId") || "";
      const question = Number(url.searchParams.get("question"));
      const durationSeconds = Number(url.searchParams.get("durationSeconds"));
      if (
        !/^[a-z0-9-]{1,100}$/.test(itemId) ||
        !url.searchParams.has("question") ||
        !Number.isInteger(question) ||
        question < 0 ||
        question > 1000 ||
        !url.searchParams.has("durationSeconds") ||
        !Number.isFinite(durationSeconds) ||
        durationSeconds < 0 ||
        durationSeconds > 7200
      )
        throw fail(400, "录音材料、题号或时长不正确");
      const item = await library.getItem(itemId);
      if (!item || item.kind !== "speaking")
        throw fail(400, "录音需关联有效口语材料");
      const suppliedType = (req.headers["content-type"] || "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      const contentType =
        suppliedType === "audio/x-wav" ? "audio/wav" : suppliedType;
      const extension = types.get(contentType);
      if (!extension) throw fail(415, "不支持此录音格式");
      if (Number(req.headers["content-length"]) > MAX_RECORDING)
        throw fail(413, "录音超过 32 MiB 限制");
      const id = randomUUID(),
        filename = `${id}.${extension}`;
      const directory = await safeRoot();
      const temporary = path.join(directory, `${id}.upload`),
        target = path.join(directory, filename);
      let handle,
        committed = false,
        size = 0;
      try {
        handle = await fs.open(
          temporary,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        // Bounded stream: only the current incoming chunk is held in memory.
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          size += chunk.length;
          if (size > MAX_RECORDING) throw fail(413, "录音超过 32 MiB 限制");
          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await handle.write(
              chunk,
              offset,
              chunk.length - offset,
            );
            offset += bytesWritten;
          }
        }
        if (!size) throw fail(400, "录音不能为空");
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.link(temporary, target); // Never overwrite an existing file.
        committed = true;
        const metadata = await store.addRecording({
          id,
          userId,
          mode,
          itemId,
          question,
          durationSeconds,
          contentType,
          size,
          filename,
        });
        return publicRecording(metadata);
      } catch (error) {
        if (committed) await fs.unlink(target).catch(() => {});
        throw error;
      } finally {
        if (handle) await handle.close().catch(() => {});
        await fs.unlink(temporary).catch(() => {});
      }
    },
    async list(userId, itemId) {
      return {
        recordings: (await store.listRecordings(userId, mode, itemId)).map(
          publicRecording,
        ),
      };
    },
    async audio(userId, id) {
      if (!UUID.test(id)) throw fail(404, "录音不存在");
      const metadata = await store.getRecording(userId, mode, id);
      if (!metadata) throw fail(404, "录音不存在");
      return { ...(await safeFile(metadata)), metadata };
    },
    async remove(userId, id) {
      if (!UUID.test(id)) throw fail(404, "录音不存在");
      const metadata = await store.getRecording(userId, mode, id);
      if (!metadata) throw fail(404, "录音不存在");
      const { target } = await safeFile(metadata);
      // DB authorisation precedes file removal; a failure never exposes another file.
      await store.deleteRecording(userId, mode, id);
      await fs.unlink(target).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      return { ok: true };
    },
  };
}

/** Local-demo metadata only. Production always uses PostgreSQL. */
export function createLocalRecordingStore(root) {
  let queue = Promise.resolve();
  async function read() {
    const file = path.join(root, "index.json");
    try {
      if ((await fs.lstat(file)).isSymbolicLink())
        throw fail(403, "录音索引不能是符号链接");
      const value = JSON.parse(await fs.readFile(file, "utf8"));
      if (!Array.isArray(value)) throw new Error("录音索引损坏");
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }
  const mutate = (operation) => {
    const pending = queue.then(async () => {
      const rows = await read();
      const result = operation(rows);
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      if ((await fs.lstat(root)).isSymbolicLink())
        throw fail(403, "录音目录不能是符号链接");
      const temporary = path.join(root, `${randomUUID()}.index`);
      try {
        await fs.writeFile(temporary, JSON.stringify(rows), {
          mode: 0o600,
          flag: "wx",
        });
        await fs.rename(temporary, path.join(root, "index.json"));
      } finally {
        await fs.unlink(temporary).catch(() => {});
      }
      return result;
    });
    queue = pending.catch(() => {});
    return pending;
  };
  const matches = (row, userId, mode, id) =>
    row.userId === userId &&
    row.mode === mode &&
    (id === undefined || row.id === id);
  return {
    async listRecordings(userId, mode, itemId) {
      await queue;
      return (await read()).filter(
        (row) =>
          matches(row, userId, mode) && (!itemId || row.itemId === itemId),
      );
    },
    async getRecording(userId, mode, id) {
      await queue;
      return (
        (await read()).find((row) => matches(row, userId, mode, id)) || null
      );
    },
    addRecording(metadata) {
      return mutate((rows) => {
        const row = { ...metadata, createdAt: new Date().toISOString() };
        rows.unshift(row);
        return row;
      });
    },
    deleteRecording(userId, mode, id) {
      return mutate((rows) => {
        const at = rows.findIndex((row) => matches(row, userId, mode, id));
        return at >= 0 ? rows.splice(at, 1)[0] : null;
      });
    },
  };
}
