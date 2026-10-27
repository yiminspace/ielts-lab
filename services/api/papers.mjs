import { createHash } from "node:crypto";
import { buildGroups, gradeGroups } from "../../apps/web/src/lib/questions.mjs";
import { paperDemo } from "./paper-demo.mjs";

const kinds = ["listening", "reading", "writing"];
const expectedParts = { listening: 4, reading: 3, writing: 2 };
const labels = { listening: "听力", reading: "阅读", writing: "写作" };
const safeLabel = (value, fallback) =>
  typeof value === "string" && value.trim()
    ? value
        .replace(/<[^>]*>/g, "")
        .trim()
        .slice(0, 200)
    : fallback;
const hashId = (sourceId) =>
  "paper-" + createHash("sha256").update(sourceId).digest("hex").slice(0, 20);

export async function buildPaperLibrary({
  sourcePapers = [],
  sourceItems = new Map(),
  getItem,
  audioExists,
}) {
  const summaries = [];
  const templates = new Map();
  const asSummary = ({ listening, reading, writing, ...paper }) => paper;

  async function resolve(summary, initialIssues = []) {
    const issues = [...initialIssues];
    const sections = {};
    for (const kind of kinds) {
      const ids = summary[`${kind}Ids`];
      const items = (await Promise.all(ids.map(getItem))).filter(Boolean);
      sections[kind] = items;
      if (
        ids.length !== expectedParts[kind] ||
        new Set(ids).size !== ids.length ||
        items.length !== ids.length
      )
        issues.push(
          `${labels[kind]}材料不完整：需要${expectedParts[kind]}个不同部分。`,
        );
      if (
        items.some(
          (item, index) =>
            item.kind !== kind ||
            Number(item.data?.[kind === "writing" ? "writingPart" : "part"]) !==
              index + 1,
        )
      )
        issues.push(`${labels[kind]}部分顺序或编号不完整。`);
      if (
        summary.source === "archive" &&
        kind !== "listening" &&
        items.some((item) => item.testTrack !== "general")
      )
        issues.push(`${labels[kind]}材料的 G 类归属存在冲突。`);
    }
    const marks = {};
    for (const kind of ["listening", "reading"]) {
      marks[kind] = sections[kind].reduce(
        (total, item) => total + gradeGroups(buildGroups(item.data), {}).total,
        0,
      );
      if (!summary.shortDemo && marks[kind] !== 40)
        issues.push(
          `${labels[kind]}题量为${marks[kind]}分，应为40分；需核对原始题目结构。`,
        );
      if (summary.shortDemo && marks[kind] === 0)
        issues.push(`${labels[kind]}短样例没有可用题目。`);
    }
    for (const item of sections.listening)
      if (!(await audioExists(item)))
        issues.push(
          `听力第${Number(item.data?.part) || "?"}部分缺少可用本地音频。`,
        );
    const paper = {
      ...summary,
      listeningMarks: marks.listening,
      readingMarks: marks.reading,
      ready: issues.length === 0,
      issues: [...summary.issues, ...issues],
    };
    return { ...paper, ...sections };
  }

  async function add(summary, issues = []) {
    templates.set(summary.id, { summary, issues });
    summaries.push(asSummary(await resolve(summary, issues)));
  }

  for (const source of sourcePapers) {
    if (!source.tracks.has("general")) continue;
    const issues = [...source.issues];
    if (source.tracks.size !== 1) issues.push("试卷目录的 A/G 归属存在冲突。");
    const summary = {
      id: hashId(source.sourceId),
      title: `${safeLabel(source.collection, "归档试卷")} · ${safeLabel(source.title, "未命名试卷")}`,
      collection: safeLabel(source.collection, "归档试卷"),
      source: "archive",
      testTrack: "general",
      issues: [],
    };
    for (const kind of kinds) {
      const links = [...(source.links[kind] || [])].sort(
        (a, b) => a.part - b.part,
      );
      const ids = [];
      for (const [index, link] of links.entries()) {
        const matches = sourceItems.get(`${kind}:${link.sourceId}`) || [];
        if (matches.length !== 1) {
          issues.push(
            `${labels[kind]}第${link.part || "?"}部分没有唯一对应的本地材料。`,
          );
          continue;
        }
        if (link.part !== index + 1)
          issues.push(`${labels[kind]}原始目录部分编号不连续。`);
        ids.push(matches[0]);
      }
      summary[`${kind}Ids`] = ids;
    }
    await add(summary, issues);
  }
  await add(paperDemo);
  const getPaper = async (id) => {
    const template = templates.get(id);
    return template ? resolve(template.summary, template.issues) : null;
  };
  return {
    papers: summaries,
    getPaper,
    // Audio readiness is checked again on each request, so a removed or
    // redirected file cannot leave a previously-ready paper launchable.
    getPapers: async () =>
      Promise.all(
        [...templates.keys()].map(async (id) => asSummary(await getPaper(id))),
      ),
  };
}
