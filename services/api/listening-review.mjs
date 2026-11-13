import {
  buildGroups,
  displayAnswer,
  parseTranscript,
} from "../../apps/web/src/lib/questions.mjs";
import {
  resolveSolutionLine,
  supportsTranscriptEvidence,
} from "../../apps/web/src/lib/question-review.mjs";

export function listeningReviewSource(item, rowId) {
  if (item?.kind !== "listening") return null;
  const data = item.data?.data?.questions ? item.data.data : item.data;
  const groups = buildGroups(data);
  const group = groups.find((entry) =>
    entry.rows.some((row) => row.id === rowId),
  );
  const row = group?.rows.find((entry) => entry.id === rowId);
  if (!row || !supportsTranscriptEvidence(row, group)) return null;
  const lines = parseTranscript(data.listenDetail, Number(data.seconds) || 0);
  if (!lines.length) return null;
  const anchor = resolveSolutionLine(row.solution, lines);
  // Keep original line indices, including when a long transcript needs a window.
  const start = Math.min(
    Math.max(0, anchor - 30),
    Math.max(0, lines.length - 120),
  );
  return {
    question: {
      number: row.number,
      endNumber: row.endNumber,
      prompt: row.content || group.content,
      directions: group.description,
      options: row.options,
      expected: row.expected,
      displayAnswer: displayAnswer(row),
      explanation: row.solution.explain || "",
    },
    lines: lines.slice(start, start + 120).map((line, offset) => ({
      index: start + offset,
      text: line.text,
    })),
  };
}
