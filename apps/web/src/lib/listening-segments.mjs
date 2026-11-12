import { assessRow, buildGroups, parseTranscript } from "./questions.mjs";
import { resolveSolutionLine } from "./question-review.mjs";

/** Keep every saved evidence hint, including all answers in a multiple-choice row. */
function evidenceIndices(solution, lines, primary) {
  const indices = [primary];
  for (const number of Array.isArray(solution?.sentenceList)
    ? solution.sentenceList
    : []) {
    indices.push(resolveSolutionLine({ sentenceList: [number] }, lines));
  }
  const phrases =
    typeof solution?.positionSentence === "string"
      ? solution.positionSentence.split(/[;；\n]/)
      : [];
  for (const phrase of phrases) {
    if (phrase.trim())
      indices.push(resolveSolutionLine({ positionSentence: phrase }, lines));
  }
  return indices.filter((index) => index >= 0);
}

/** Use original sentence timestamps and overlapping context around all evidence. */
export function listeningSegments(data, duration = Number(data.seconds) || 0) {
  const lines = parseTranscript(data.listenDetail, duration);
  const groups = buildGroups(data);
  const entries = groups.flatMap((group) =>
    group.rows.map((row) => ({
      row,
      group,
      index: resolveSolutionLine(row.solution, lines),
    })),
  );
  if (!entries.length || !lines.length)
    return {
      segments: [],
      error: "这份材料缺少题目或带时间的原文，暂时无法分段。",
    };
  if (entries.some((entry) => entry.index < 0))
    return { segments: [], error: "部分题目缺少答案定位，暂时无法完整分段。" };
  if (
    entries.some(
      (entry, i) =>
        i > 0 && lines[entry.index].start < lines[entries[i - 1].index].start,
    )
  )
    return {
      segments: [],
      error: "答案定位与题目顺序不一致，暂时无法连续分段。",
    };
  const segments = [];
  for (const entry of entries) {
    const position = lines[entry.index].start;
    const last = segments.at(-1);
    if (last && last.position === position) last.entries.push(entry);
    else segments.push({ position, entries: [entry] });
  }
  const spans = segments.map((segment) => {
    const indices = segment.entries.flatMap((entry) =>
      evidenceIndices(entry.row.solution, lines, entry.index),
    );
    return { first: Math.min(...indices), last: Math.max(...indices) };
  });
  // Divide intervening sentences between neighbours, then extend each side to
  // include two leading and three trailing context sentences. Overlap is intentional.
  const boundaries = spans
    .slice(1)
    .map((span, i) => Math.floor((spans[i].last + span.first) / 2));
  return {
    error: "",
    segments: segments.map((segment, i) => {
      const first = Math.max(
        0,
        Math.min(i === 0 ? 0 : boundaries[i - 1] + 1, spans[i].first - 2),
      );
      const last = Math.min(
        lines.length - 1,
        Math.max(
          i === segments.length - 1 ? lines.length - 1 : boundaries[i],
          spans[i].last + 3,
        ),
      );
      const start = i === 0 ? 0 : lines[first].start;
      const end =
        last < lines.length - 1
          ? lines[last].end
          : duration > start
            ? duration
            : null;
      return {
        ...segment,
        start,
        end,
        lines: lines.slice(first, last + 1),
      };
    }),
  };
}

/**
 * Answer-sentence positions of segments with any question the attempt did not
 * fully earn (wrong, blank or partially right). Manual-review rows are skipped.
 */
export function missedSegmentPositions(segments, answers) {
  if (!answers) return new Set();
  return new Set(
    segments
      .filter((segment) =>
        segment.entries.some(({ row }) =>
          ["incorrect", "blank", "partial"].includes(
            assessRow(row, answers[row.id]).status,
          ),
        ),
      )
      .map((segment) => segment.position),
  );
}
