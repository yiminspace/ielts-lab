import { assessRow, buildGroups, parseTranscript } from "./questions.mjs";
import { resolveSolutionLine } from "./question-review.mjs";

/** Use saved answer sentence timestamps; never estimate word timings. */
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
  return {
    error: "",
    segments: segments.map((segment, i) => {
      const start = i === 0 ? 0 : segment.position;
      const end =
        segments[i + 1]?.position ?? (duration > start ? duration : null);
      return {
        ...segment,
        start,
        end,
        lines: lines.filter(
          (line) => line.start >= start && (end === null || line.start < end),
        ),
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
