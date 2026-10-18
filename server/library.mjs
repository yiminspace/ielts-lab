import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { demoItems } from "./demo.mjs";
import { generalTrainingItems } from "./general-training.mjs";
import { paperDemoItems } from "./paper-demo.mjs";
import { buildPaperLibrary } from "./papers.mjs";
import {
  classifyTestTrack,
  testTrackEvidence,
} from "../src/lib/test-track.mjs";

const categories = {
  听力: "listening",
  阅读: "reading",
  写作: "writing",
  口语: "speaking",
  词库: "vocabulary",
  句库: "sentences",
  语法分析: "grammar",
  数字听写: "numbers",
  打字练习: "typing",
  公开课: "courses",
};
const privateKeys =
  /^(?:user|users|userInfo|userId|userName|username|phone|mobile|email|token|accessToken|refreshToken|authorization|cookie|password|updateId|updateName|createBy|createdBy|creatorId|teacherPhone|sourceEndpoints)$/i;
const collator = new Intl.Collator("zh-CN", { numeric: true });
const idFor = (value) =>
  createHash("sha256").update(value).digest("hex").slice(0, 20);
export const inside = (root, candidate) =>
  candidate === root || candidate.startsWith(root + path.sep);

const originalItems = [...demoItems, ...generalTrainingItems].map((item) => ({
  ...item,
  source: "original",
  testTrack: classifyTestTrack({
    ...item,
    // These original examples were authored for these formats. Archive books
    // never receive a track from an ID or from the appearance of the task.
    testTrack:
      item.id === "demo-reading"
        ? "academic"
        : item.id === "demo-writing"
          ? "shared"
          : item.testTrack,
  }),
}));
const generalItems = originalItems.filter((item) =>
  generalTrainingItems.some((original) => original.id === item.id),
);
const publicItem = ({ data, localMedia, ...item }) => item;

async function readInsideJSON(file, directory) {
  const real = await fs.realpath(file);
  if (!inside(directory, real)) throw new Error("分类元数据超出允许目录");
  return JSON.parse(await fs.readFile(real, "utf8"));
}

// Only material identifiers are retained. Account/session data and request
// metadata are never returned by the library or added to the media allowlist.
async function archiveTrackIndex(root, organized) {
  const papers = new Map();
  const memberships = new Map();
  const records = new Map();
  const add = (map, key, track) => {
    if (typeof key !== "string" || !key || key.length > 200) return;
    const values = map.get(key) || new Set();
    values.add(track);
    map.set(key, values);
  };
  for (const file of await walk(path.join(organized, "模考目录"))) {
    try {
      const raw = await readInsideJSON(file, organized);
      const track = classifyTestTrack({ kind: "reading", title: raw.title });
      if (!["academic", "general"].includes(track)) continue;
      for (const collection of raw.data?.paperList || [])
        for (const paper of collection.testPapers || []) {
          const sourceId = String(paper.paperId ?? "");
          add(papers, sourceId, track);
          if (!papers.has(sourceId)) continue;
          const record = records.get(sourceId) || {
            sourceId,
            title: paper.paperName,
            collection: collection.topicName,
            tracks: papers.get(sourceId),
            links: {},
            issues: [],
          };
          if (
            record.title !== paper.paperName ||
            record.collection !== collection.topicName
          )
            record.issues.push("同一试卷在目录中的名称或合集存在冲突。");
          records.set(sourceId, record);
        }
    } catch {
      // Missing or malformed classification evidence leaves items unclassified.
    }
  }
  const result = () => ({ memberships, papers: [...records.values()] });
  if (!papers.size) return result();
  let requests;
  const catalogRoot = path.join(root, "data/目录");
  const rawRoot = path.join(root, "data/raw/hcp");
  try {
    requests = await readInsideJSON(
      path.join(catalogRoot, "请求来源.json"),
      catalogRoot,
    );
  } catch {
    return result();
  }
  if (!Array.isArray(requests)) return result();
  for (const request of requests) {
    const kind =
      request?.path === "/hcp/qsBank/listening/examListeningV2"
        ? "listening"
        : request?.path === "/hcp/qsBank/passages/examPassagesV2"
          ? "reading"
          : request?.path === "/hcp/qsBank/writings/examWritingsV2"
            ? "writing"
            : null;
    if (
      !kind ||
      !/^data\/raw\/hcp\/[a-f0-9]{64}\.json$/.test(request.file || "")
    )
      continue;
    try {
      const params =
        typeof request.params === "string"
          ? JSON.parse(request.params)
          : request.params;
      const paperId = String(params?.testPaperId ?? "");
      const tracks = papers.get(paperId);
      if (!tracks?.size) continue;
      const response = await readInsideJSON(
        path.join(root, request.file),
        rawRoot,
      );
      if (response.status !== 0 || !Array.isArray(response.content)) continue;
      const links = [];
      for (const row of response.content) {
        const id =
          row?.[
            {
              listening: "listeningId",
              reading: "passagesId",
              writing: "writingId",
            }[kind]
          ];
        if (typeof id !== "string" || !id || id.length > 200) continue;
        links.push({
          sourceId: id,
          part: Number(row[kind === "writing" ? "writingPart" : "part"]),
        });
        for (const track of tracks) add(memberships, `${kind}:${id}`, track);
      }
      const record = records.get(paperId);
      if (
        record.links[kind] &&
        JSON.stringify(record.links[kind]) !== JSON.stringify(links)
      )
        record.issues.push("同一试卷存在相互冲突的材料关联记录。");
      else record.links[kind] = links;
    } catch {
      // The study material itself remains usable when provenance is unavailable.
    }
  }
  return result();
}

function archiveItemTrack(item, data, memberships) {
  if (!["reading", "writing"].includes(item.kind)) return "shared";
  const key = `${item.kind}:${data?.[item.kind === "reading" ? "passagesId" : "writingId"] ?? ""}`;
  const evidence = new Set([
    ...(memberships.get(key) || []),
    ...testTrackEvidence(item, data),
  ]);
  return evidence.size === 1 ? [...evidence][0] : "unclassified";
}

async function walk(root) {
  const result = [];
  for (const entry of await fs
    .readdir(root, { withFileTypes: true })
    .catch(() => [])) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await walk(file)));
    else if (entry.isFile() && entry.name.endsWith(".json")) result.push(file);
  }
  return result.sort(collator.compare);
}
function mediaReference(file, value, mediaRoot) {
  if (typeof value !== "string") return null;
  const target = path.resolve(path.dirname(file), value);
  if (!inside(mediaRoot, target)) return null;
  const relative = path.relative(mediaRoot, target).split(path.sep).join("/");
  if (
    !/^[a-f0-9]{2}\/[a-f0-9]{64}\.(?:mp3|mpga|wav|m4a|ogg|mp4|webm|png|jpe?g|webp)$/i.test(
      relative,
    )
  )
    return null;
  return "/media/" + relative;
}
function countFor(kind, data) {
  if (kind === "listening" || kind === "reading")
    return (data.questions || []).reduce(
      (total, q) => total + (q.questionCount || q.answerJson?.length || 0),
      0,
    );
  if (kind === "speaking") return data.oralQuestionDetailVOList?.length || 0;
  if (Array.isArray(data.items)) return data.items.length;
  if (Array.isArray(data.sentences)) return data.sentences.length;
  return 1;
}
function sanitize(value, media, depth = 0) {
  if (depth > 80) return null;
  if (Array.isArray(value))
    return value.map((item) => sanitize(item, media, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !privateKeys.test(key) &&
            !["__proto__", "constructor", "prototype"].includes(key),
        )
        .map(([key, item]) => [key, sanitize(item, media, depth + 1)]),
    );
  if (typeof value !== "string") return value;
  if (media.has(value)) return media.get(value);
  // URLs inside rich text are rewritten only when present in the local archive.
  return value.replace(
    /\b(src|href|poster)\s*=\s*(["'])(.*?)\2/gi,
    (match, attribute, quote, url) => {
      const decoded = url.replaceAll("&amp;", "&");
      const local = media.get(decoded) || media.get(url);
      if (local) return `${attribute}=${quote}${local}${quote}`;
      // The renderer sanitizes HTML too. Dropping unarchived URLs keeps study content offline.
      if (/^(?:https?:|\/\/|file:|javascript:|data:)/i.test(decoded.trim()))
        return "";
      return match;
    },
  );
}
export async function validateArchive(root) {
  const realRoot = await fs.realpath(root);
  for (const relative of ["data/整理", "data/media"]) {
    const directory = await fs.realpath(path.join(realRoot, relative));
    if (
      !inside(realRoot, directory) ||
      !(await fs.stat(directory)).isDirectory()
    )
      throw new Error("归档缺少受支持的学习材料目录");
  }
  return realRoot;
}

export async function loadLibrary({ archiveRoot, forceDemo = false } = {}) {
  const originalItem = (id) => paperDemoItems.find((item) => item.id === id);
  const originalAudioExists = async (item) => {
    if (item.data?.audioUrl !== "/media/demo-listening.wav") return false;
    try {
      const directory = await fs.realpath(
        new URL("./assets/", import.meta.url),
      );
      const file = await fs.realpath(
        new URL("./assets/demo-listening.wav", import.meta.url),
      );
      if (!inside(directory, file)) return false;
      const stat = await fs.stat(file);
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  };
  if (!archiveRoot || forceDemo) {
    const items = originalItems.map(publicItem);
    const getItem = async (id) =>
      originalItem(id) || originalItems.find((item) => item.id === id) || null;
    const papers = await buildPaperLibrary({
      getItem,
      audioExists: originalAudioExists,
    });
    return {
      ...papers,
      mode: "demo",
      archiveRoot: null,
      mediaRoot: null,
      allowedMedia: new Set(),
      publicLibrary: {
        items,
        mode: "demo",
        counts: tally(items),
        issues: [
          "当前为原创演示材料；可在本机导入已有学习归档。AI 评分及真人服务未接入。",
        ],
      },
      getItem,
    };
  }
  const root = await validateArchive(archiveRoot);
  const organized = path.join(root, "data/整理");
  const mediaRoot = path.join(root, "data/media");
  const globalMedia = new Map();
  const pronunciations = new Map();
  const records = new Map();
  const sourceItems = new Map();
  const items = generalItems.map(publicItem);
  const trackIndex = await archiveTrackIndex(root, organized);
  const trackMemberships = trackIndex.memberships;
  const issues = [];
  const allowedMedia = new Set();
  let badDocuments = 0;
  let absentPronunciations = 0;
  async function readSafe(file) {
    const real = await fs.realpath(file);
    if (!inside(organized, real)) throw new Error("学习文件超出目录");
    return JSON.parse(await fs.readFile(real, "utf8"));
  }
  function addMedia(file, sourceMap) {
    const pairs = [];
    for (const [source, value] of Object.entries(sourceMap || {})) {
      const local = mediaReference(file, value, mediaRoot);
      if (local) {
        globalMedia.set(source, local);
        allowedMedia.add(local.slice("/media/".length));
        pairs.push([source, local]);
      }
    }
    return pairs;
  }
  // Pronunciation manifests contain only content identifiers and cached audio mappings.
  for (const file of await walk(path.join(organized, "发音链接"))) {
    try {
      const raw = await readSafe(file);
      addMedia(file, raw.localMedia);
      for (const row of raw.data?.items || []) {
        const local = globalMedia.get(row.audioUrl);
        if (local) {
          const key = `${row.manifestType}:${row.targetId}`;
          const value = pronunciations.get(key) || {};
          value[row.accent] = local;
          pronunciations.set(key, value);
        } else absentPronunciations++;
      }
    } catch {
      badDocuments++;
    }
  }
  for (const [category, kind] of Object.entries(categories)) {
    for (const file of await walk(path.join(organized, category))) {
      try {
        const raw = await readSafe(file);
        if (!raw || typeof raw !== "object" || !raw.data) {
          badDocuments++;
          continue;
        }
        const media = addMedia(file, raw.localMedia);
        const relative = path.relative(organized, file);
        const subcollection = path.relative(
          path.join(organized, category),
          path.dirname(file),
        );
        const collection =
          subcollection || raw.data.declaredCollection?.title || category;
        const rows =
          kind === "typing" && Array.isArray(raw.data) ? raw.data : [raw.data];
        rows.forEach((data, index) => {
          const id = `${kind}-${idFor(relative + (kind === "typing" ? ":" + index : ""))}`;
          const item = {
            id,
            kind,
            title: String(
              kind === "typing"
                ? data.title || `练习 ${index + 1}`
                : raw.title || path.basename(file, ".json"),
            ),
            collection,
            count: countFor(kind, data),
            source: "archive",
          };
          item.testTrack = archiveItemTrack(item, data, trackMemberships);
          if (["listening", "reading", "writing"].includes(kind)) {
            const sourceId =
              data[
                {
                  listening: "listeningId",
                  reading: "passagesId",
                  writing: "writingId",
                }[kind]
              ];
            if (typeof sourceId === "string" && sourceId) {
              const key = `${kind}:${sourceId}`;
              sourceItems.set(key, [...(sourceItems.get(key) || []), id]);
            }
          }
          items.push(item);
          records.set(id, {
            file,
            index: kind === "typing" ? index : null,
            media,
            item,
          });
        });
      } catch {
        badDocuments++;
      }
    }
  }
  items.sort(
    (a, b) =>
      collator.compare(a.collection, b.collection) ||
      collator.compare(a.title, b.title),
  );
  if (badDocuments)
    issues.push(`${badDocuments} 个学习文件无法解析，未列入目录。`);
  if (absentPronunciations)
    issues.push(
      `${absentPronunciations} 条发音记录没有本地音频，练习时会提示缺失。`,
    );
  const unclassified = items.filter(
    (item) => item.testTrack === "unclassified",
  ).length;
  if (unclassified)
    issues.push(
      `${unclassified} 项阅读或写作材料缺少可核实的 A/G 归属，保留在全部材料中。`,
    );
  issues.push(
    "仅导入已归档的学习材料；训练营、账号信息、原软件个人记录不在导入范围。",
    "部分完整口语范文、中文翻译与原始课件未包含在归档中；AI 评分及真人服务未接入。",
  );
  const getItem = async (id) => {
    const original =
      originalItem(id) || generalItems.find((item) => item.id === id);
    if (original) return original;
    const record = records.get(id);
    if (!record) return null;
    const raw = await readSafe(record.file);
    const originalData =
      record.index === null ? raw.data : raw.data[record.index];
    const data = sanitize(originalData, globalMedia);
    const localMedia = Object.fromEntries(record.media);
    const rows = data?.items || data?.sentences || [];
    if (["vocabulary", "sentences", "grammar"].includes(record.item.kind)) {
      for (const row of rows) {
        const type = record.item.kind === "vocabulary" ? "word" : "sentence";
        const targetId = type === "word" ? row.headWord : row.sentenceId;
        row.audioUrls = pronunciations.get(`${type}:${targetId}`) || {};
      }
    }
    return { ...record.item, data, localMedia };
  };
  const itemCache = new Map();
  const papers = await buildPaperLibrary({
    sourcePapers: trackIndex.papers,
    sourceItems,
    getItem: async (id) => {
      if (!itemCache.has(id)) itemCache.set(id, getItem(id));
      return itemCache.get(id);
    },
    audioExists: async (item) => {
      if (item.source === "original") return originalAudioExists(item);
      const url = item.data?.audioUrl;
      if (typeof url !== "string" || !url.startsWith("/media/")) return false;
      const relative = url.slice(7);
      if (
        !allowedMedia.has(relative) ||
        !/\.(?:mp3|mpga|wav|m4a|ogg)$/i.test(relative)
      )
        return false;
      try {
        const file = await fs.realpath(path.join(mediaRoot, relative));
        if (!inside(mediaRoot, file)) return false;
        const stat = await fs.stat(file);
        return stat.isFile() && stat.size > 0;
      } catch {
        return false;
      }
    },
  });
  return {
    ...papers,
    mode: "archive",
    archiveRoot: root,
    mediaRoot,
    allowedMedia,
    publicLibrary: { items, mode: "archive", counts: tally(items), issues },
    getItem,
  };
}
export function tally(items) {
  return items.reduce(
    (result, item) => ({
      ...result,
      [item.kind]: (result[item.kind] || 0) + 1,
    }),
    {},
  );
}
