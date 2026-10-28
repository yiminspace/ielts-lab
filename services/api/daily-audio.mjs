import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const maximum = 32 * 1024 * 1024;
const fail = (status, message) => Object.assign(new Error(message), { status });
const types = new Map([
  ["audio/webm", "webm"],
  ["audio/ogg", "ogg"],
  ["audio/mp4", "m4a"],
  ["audio/mpeg", "mp3"],
  ["audio/wav", "wav"],
  ["audio/x-wav", "wav"],
]);
export function createDailyAudio(root) {
  if (!path.isAbsolute(root)) throw new Error("DAILY_ROOT 必须是绝对路径");
  async function directory(owner, mode, lessonId) {
    if (
      !/^[a-f0-9-]{36}$/i.test(owner) ||
      !["archive", "demo"].includes(mode) ||
      !/^daily-[a-f0-9]{40}$/.test(lessonId)
    )
      throw fail(400, "录音身份无效");
    const target = path.join(root, owner, mode, lessonId);
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    for (const candidate of [
      root,
      path.join(root, owner),
      path.join(root, owner, mode),
      target,
    ])
      if ((await fs.lstat(candidate)).isSymbolicLink())
        throw fail(403, "音频目录不能是符号链接");
    const canonicalTarget = path.join(
      await fs.realpath(root),
      owner,
      mode,
      lessonId,
    );
    if ((await fs.realpath(target)) !== canonicalTarget)
      throw fail(403, "音频目录不被允许");
    return canonicalTarget;
  }
  return {
    async existing(owner, mode, lessonId, requestId, kind) {
      const id = `${kind}-${createHash("sha256").update(`${lessonId}:${requestId}`).digest("hex").slice(0, 32)}`;
      const dir = await directory(owner, mode, lessonId);
      const files = (await fs.readdir(dir)).filter((name) =>
        name.startsWith(`${id}.`),
      );
      if (!files.length) return null;
      if (files.length !== 1)
        throw fail(409, "同一语音请求存在冲突文件，请保留记录并检查");
      const filename = files[0];
      const extension = path.extname(filename).slice(1);
      const contentType = {
        webm: "audio/webm",
        ogg: "audio/ogg",
        m4a: "audio/mp4",
        mp3: "audio/mpeg",
        wav: "audio/wav",
      }[extension];
      if (!contentType) throw fail(403, "音频格式不被允许");
      const handle = await fs.open(
        path.join(dir, filename),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size <= 0 || stat.size > maximum)
          throw fail(403, "音频文件不被允许");
        const bytes = await handle.readFile();
        return {
          id,
          filename,
          contentType,
          size: bytes.length,
          checksum: createHash("sha256").update(bytes).digest("hex"),
        };
      } finally {
        await handle.close();
      }
    },
    async save(owner, mode, lessonId, requestId, kind, contentType, iterable) {
      const normalized = contentType.split(";")[0].trim().toLowerCase();
      const extension = types.get(normalized);
      if (!extension) throw fail(415, "不支持此音频格式");
      const id = `${kind}-${createHash("sha256").update(`${lessonId}:${requestId}`).digest("hex").slice(0, 32)}`;
      const dir = await directory(owner, mode, lessonId);
      const filename = `${id}.${extension}`;
      const target = path.join(dir, filename),
        temporary = path.join(dir, `${randomUUID()}.upload`);
      const digest = createHash("sha256");
      let size = 0,
        handle;
      try {
        handle = await fs.open(
          temporary,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        for await (const chunk of iterable) {
          size += chunk.length;
          if (size > maximum) throw fail(413, "录音超过 32 MiB 限制");
          digest.update(chunk);
          await handle.writeFile(chunk);
        }
        if (!size) throw fail(400, "录音不能为空");
        await handle.sync();
        await handle.close();
        handle = null;
        const checksum = digest.digest("hex");
        try {
          await fs.link(temporary, target);
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          const previous = await fs.open(
            target,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            const data = await previous.readFile();
            if (createHash("sha256").update(data).digest("hex") !== checksum)
              throw fail(409, "相同 requestId 已保存另一段录音");
          } finally {
            await previous.close();
          }
        }
        return {
          id,
          filename,
          size,
          checksum,
          contentType: normalized === "audio/x-wav" ? "audio/wav" : normalized,
        };
      } finally {
        await handle?.close();
        await fs.unlink(temporary).catch(() => {});
      }
    },
    async file(owner, mode, lessonId, metadata) {
      if (
        !/^(?:recording|teacher)-[a-f0-9]{32}\.(?:webm|ogg|m4a|mp3|wav)$/.test(
          metadata.filename,
        )
      )
        throw fail(404, "音频不存在");
      const dir = await directory(owner, mode, lessonId);
      const target = path.join(dir, metadata.filename),
        stat = await fs.lstat(target);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        (await fs.realpath(target)) !== target
      )
        throw fail(403, "音频文件不被允许");
      return { directory: dir, target, metadata };
    },
  };
}
