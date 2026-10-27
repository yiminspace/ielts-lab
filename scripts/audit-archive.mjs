/** Optional read-only compatibility audit. Prints counts and structural issues, never source text or answers. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildGroups,
  gradeGroups,
  parseTranscript,
} from "../apps/web/src/lib/questions.mjs";
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const supplied = process.argv[2];
let archiveRoot = supplied;
if (!archiveRoot) {
  try {
    archiveRoot = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "config.local.json"), "utf8"),
    ).archiveRoot;
  } catch {
    /* Usage below explains the missing configuration. */
  }
}
if (!archiveRoot || !path.isAbsolute(archiveRoot)) {
  console.error(
    "Usage: node scripts/audit-archive.mjs /absolute/path/to/archive-root (or import an archive first)",
  );
  process.exit(1);
}
const walk = (folder) =>
  fs
    .readdirSync(folder, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? walk(path.join(folder, entry.name))
        : entry.isFile() && entry.name.endsWith(".json")
          ? [path.join(folder, entry.name)]
          : [],
    );
const report = {
  source: "archive",
  items: 0,
  groups: 0,
  questionMarks: 0,
  manualMarks: 0,
  standardAnswerChecksPassed: true,
  types: {},
  transcriptItems: 0,
  inlineGroups: 0,
  fallbackGroups: [],
  gradeMismatches: [],
};
for (const category of ["听力", "阅读"]) {
  for (const file of walk(path.join(archiveRoot, "data", "整理", category))) {
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    const data = record.data || record;
    const groups = buildGroups(data);
    const answers = {};
    for (const group of groups) {
      report.groups++;
      report.types[group.type] = (report.types[group.type] || 0) + 1;
      for (const row of group.rows) {
        answers[row.id] =
          row.type === "0"
            ? String(row.expected).includes("|")
              ? String(row.expected)
                  .split("|")
                  .map((x) => x.split("/")[0])
              : String(row.expected).split("/")[0]
            : Array.isArray(row.expected)
              ? row.expected.map(String)
              : String(row.expected);
      }
      if (["0", "4"].includes(group.type)) {
        const actual = (
          String(group.content)
            .replace(/<[^>]*>/g, "")
            .match(/\.{6}/g) || []
        ).length;
        const expected = group.rows.reduce((n, row) => n + row.slots, 0);
        if (actual === expected) report.inlineGroups++;
        else
          report.fallbackGroups.push({
            file: path.relative(archiveRoot, file),
            firstQuestion: group.start,
            sourceGaps: actual,
            answerSlots: expected,
          });
      }
    }
    const result = gradeGroups(groups, answers);
    report.questionMarks += result.total;
    report.manualMarks += result.manual;
    report.items++;
    if (result.score + result.manual !== result.total) {
      report.standardAnswerChecksPassed = false;
      report.gradeMismatches.push(path.relative(archiveRoot, file));
    }
    if (category === "听力" && parseTranscript(data.listenDetail).length)
      report.transcriptItems++;
  }
}
console.log(JSON.stringify(report, null, 2));
if (!report.standardAnswerChecksPassed) process.exitCode = 1;
