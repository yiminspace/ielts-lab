import { displayAnswer } from "./questions.mjs";

/** Resolve saved solution hints against the transcript that is actually visible. */
export function resolveSolutionLine(solution, lines) {
  if (!Array.isArray(lines) || !lines.length) return -1;
  const first = Array.isArray(solution?.sentenceList)
    ? solution.sentenceList[0]
    : undefined;
  const number =
    typeof first === "number" || typeof first === "string"
      ? Number(first)
      : NaN;
  let index =
    Number.isInteger(number) && number > 0 && number <= lines.length
      ? number - 1
      : -1;
  const phrase =
    typeof solution?.positionSentence === "string"
      ? solution.positionSentence
          .split(/[;；\n]/)
          .find((part) => part.trim())
          ?.trim()
          .toLowerCase()
      : undefined;
  if (phrase) {
    const matching = lines.findIndex(
      (line) =>
        typeof line?.text === "string" &&
        line.text.toLowerCase().includes(phrase),
    );
    if (matching >= 0) index = matching;
  }
  return index;
}

/** Keep long accepted spellings compact without inventing a per-slot answer key. */
export function compactAnswer(row) {
  const full = displayAnswer(row);
  if (
    row.type !== "0" ||
    row.slots !== 1 ||
    typeof row.expected !== "string" ||
    row.expected.includes("|")
  )
    return { primary: full, alternatives: [] };
  const variants = [
    ...new Set(
      row.expected
        .split("/")
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ];
  return {
    primary: variants[0] ?? full,
    alternatives: variants.slice(1),
  };
}

/** Complete only a single text blank whose accepted answer has a known slot. */
export function completedBlankAnswer(row) {
  if (
    row.type !== "0" ||
    row.slots !== 1 ||
    !row.supported ||
    typeof row.expected !== "string" ||
    row.expected.includes("|")
  )
    return null;
  return (
    row.expected
      .split("/")
      .map((part) => part.trim())
      .find(Boolean) ?? null
  );
}
