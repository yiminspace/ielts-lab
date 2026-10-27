import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadLibrary,
  validateArchive,
  inside,
} from "../services/api/library.mjs";

const categories = [
  "听力",
  "阅读",
  "写作",
  "口语",
  "词库",
  "句库",
  "语法分析",
  "数字听写",
  "打字练习",
  "公开课",
  "发音链接",
  "模考目录",
];
const privateKey =
  /^(?:user|users|userInfo|userId|userName|username|phone|mobile|email|token|accessToken|refreshToken|authorization|cookie|password|updateId|updateName|createBy|createdBy|creatorId|teacherPhone|sourceEndpoints|headers|requestHeaders)$/i;
function scrub(value, depth = 0) {
  if (depth > 80) throw new Error("Material nesting is too deep");
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !privateKey.test(key) &&
            !["__proto__", "constructor", "prototype"].includes(key),
        )
        .map(([key, v]) => [key, scrub(v, depth + 1)]),
    );
  return value;
}
async function json(file, root) {
  const real = await fs.realpath(file);
  if (!inside(root, real))
    throw new Error("Source file escapes allowed directory");
  return JSON.parse(await fs.readFile(real, "utf8"));
}
async function writeJSON(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify(value) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
}
async function walk(directory) {
  const result = [];
  for (const entry of await fs
    .readdir(directory, { withFileTypes: true })
    .catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await walk(file)));
    else if (entry.isFile() && entry.name.endsWith(".json")) result.push(file);
  }
  return result;
}
export async function exportArchive(source, destination) {
  const root = await validateArchive(source);
  if (!path.isAbsolute(destination))
    throw new Error("Destination must be absolute");
  const target = path.resolve(destination);
  if (inside(root, target) || inside(target, root))
    throw new Error("Source and destination must be separate");
  // Never overwrite a previous export or follow a caller-controlled destination symlink.
  const parent = await fs.realpath(path.dirname(target));
  if (parent !== path.dirname(target))
    throw new Error("Destination parent must not use symlinks");
  await fs.mkdir(target, { mode: 0o700 });
  const library = await loadLibrary({ archiveRoot: root });
  const organized = path.join(root, "data/整理"),
    media = path.join(root, "data/media");
  let documents = 0,
    mediaFiles = 0,
    mediaBytes = 0,
    paperLinks = 0;
  await fs.mkdir(path.join(target, "data/整理"), {
    recursive: true,
    mode: 0o700,
  });
  await fs.mkdir(path.join(target, "data/media"), {
    recursive: true,
    mode: 0o700,
  });
  for (const category of categories)
    for (const file of await walk(path.join(organized, category))) {
      const raw = await json(file, organized);
      if (!raw || typeof raw !== "object" || !raw.data) continue;
      const localMedia = {};
      for (const [key, value] of Object.entries(raw.localMedia || {})) {
        if (typeof value !== "string") continue;
        const resolved = path.resolve(path.dirname(file), value);
        if (!inside(media, resolved)) continue;
        const relative = path
          .relative(media, resolved)
          .split(path.sep)
          .join("/");
        if (library.allowedMedia.has(relative)) localMedia[key] = value;
      }
      await writeJSON(
        path.join(target, "data/整理", path.relative(organized, file)),
        { title: raw.title, data: scrub(raw.data), localMedia },
      );
      documents++;
    }
  for (const relative of library.allowedMedia) {
    const real = await fs.realpath(path.join(media, relative));
    if (!inside(media, real)) throw new Error("Media escapes source directory");
    const stat = await fs.stat(real);
    if (!stat.isFile()) throw new Error("Media must be a regular file");
    const file = path.join(target, "data/media", relative);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.copyFile(
      real,
      file,
      constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
    );
    mediaFiles++;
    mediaBytes += stat.size;
  }
  const requests = [];
  let entries = [];
  try {
    entries = await json(
      path.join(root, "data/目录/请求来源.json"),
      path.join(root, "data/目录"),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const paths = new Map([
    ["/hcp/qsBank/listening/examListeningV2", "listeningId"],
    ["/hcp/qsBank/passages/examPassagesV2", "passagesId"],
    ["/hcp/qsBank/writings/examWritingsV2", "writingId"],
  ]);
  for (const entry of Array.isArray(entries) ? entries : []) {
    const key = paths.get(entry?.path);
    if (!key || !/^data\/raw\/hcp\/[a-f0-9]{64}\.json$/.test(entry.file || ""))
      continue;
    const params =
      typeof entry.params === "string"
        ? JSON.parse(entry.params)
        : entry.params;
    if (!params?.testPaperId) continue;
    const response = await json(
      path.join(root, entry.file),
      path.join(root, "data/raw/hcp"),
    );
    if (response.status !== 0 || !Array.isArray(response.content)) continue;
    const file = path.join(target, entry.file);
    try {
      await writeJSON(file, {
        status: 0,
        content: response.content.map((row) => ({
          [key]: row[key],
          part: row.part,
          writingPart: row.writingPart,
        })),
      });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    requests.push({
      path: entry.path,
      file: entry.file,
      params: { testPaperId: params.testPaperId },
    });
    paperLinks++;
  }
  if (requests.length)
    await writeJSON(path.join(target, "data/目录/请求来源.json"), requests);
  const exported = await loadLibrary({ archiveRoot: target });
  const ids = (lib) => lib.publicLibrary.items.map((item) => item.id).sort();
  if (JSON.stringify(ids(library)) !== JSON.stringify(ids(exported)))
    throw new Error("Export changed material identifiers");
  const papers = await library.getPapers(),
    exportedPapers = await exported.getPapers();
  if (JSON.stringify(papers) !== JSON.stringify(exportedPapers))
    throw new Error("Export changed paper structure or readiness");
  return {
    documents,
    mediaFiles,
    mediaBytes,
    paperLinks,
    materials: ids(exported).length,
    papers: exportedPapers.length,
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(
      JSON.stringify(await exportArchive(process.argv[2], process.argv[3])),
    );
  } catch (error) {
    console.error("Archive export failed:", error.message);
    process.exitCode = 1;
  }
}
