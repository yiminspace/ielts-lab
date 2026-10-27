/** Language practice helpers. No source material is embedded in this module. */
export function countWords(value = "") {
  return (String(value).match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) || [])
    .length;
}

export function normalizeDictation(value = "", kind = "sentences") {
  const text = String(value)
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[‘’]/g, "'")
    .trim();
  if (kind === "numbers")
    return text.replace(/[\s,，\-–—]/g, "").replace(/[!?。！？]+$/g, "");
  return (text.match(/[\p{L}\p{N}]+(?:['.][\p{L}\p{N}]+)*/gu) || []).join(" ");
}

export function checkDictation(input, expected, kind = "sentences") {
  const normalized = normalizeDictation(input, kind);
  return (
    normalized.length > 0 && normalized === normalizeDictation(expected, kind)
  );
}

export function typingMetrics(input, target, elapsedSeconds) {
  const entered = Array.from(String(input));
  const expected = Array.from(String(target));
  let correct = 0;
  for (let index = 0; index < entered.length; index++)
    if (entered[index] === expected[index]) correct++;
  return {
    correct,
    accuracy: entered.length
      ? Math.round((correct / entered.length) * 100)
      : 100,
    wpm:
      elapsedSeconds > 0 ? Math.round(correct / 5 / (elapsedSeconds / 60)) : 0,
    progress: expected.length
      ? Math.min(100, Math.round((entered.length / expected.length) * 100))
      : 0,
    complete: expected.length > 0 && String(input) === String(target),
  };
}

export function formatTime(seconds = 0) {
  const n = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
}

/** A blank submitted response is still a valid history entry, never a draft fallback. */
export function writingReview(itemId, attempt) {
  if (!attempt || attempt.kind !== "writing" || attempt.itemId !== itemId)
    return null;
  const answers = attempt.answers || {};
  const text =
    typeof answers.essay === "string"
      ? answers.essay
      : typeof answers.text === "string"
        ? answers.text
        : null;
  if (text === null) return null;
  return {
    text,
    notes: typeof answers.notes === "string" ? answers.notes : "",
    words: countWords(text),
    durationSeconds:
      typeof attempt.durationSeconds === "number" &&
      Number.isFinite(attempt.durationSeconds) &&
      attempt.durationSeconds >= 0
        ? attempt.durationSeconds
        : null,
    sharedTiming:
      typeof answers.paperRunId === "string" && !!answers.paperRunId,
  };
}

/** Resolve an earlier attempt to the original row, including legacy index-only entries. */
export function reviewIndex(rows, attempt, kind, fallback = 0) {
  const safeFallback = Math.max(
    0,
    Math.min(Number(fallback) || 0, Math.max(0, rows.length - 1)),
  );
  if (!attempt || !Array.isArray(rows) || !rows.length) return safeFallback;
  const keys = Object.keys(attempt.answers || {});
  for (const key of keys) {
    const index = rows.findIndex((row, index) => {
      const id =
        kind === "vocabulary"
          ? row.wordId || row.id || row.headWord || row.word
          : row.sentenceId || row.id || index;
      return String(id) === key;
    });
    if (index >= 0) return index;
  }
  const ordinal = /第\s*(\d+)\s*[条题]/.exec(attempt.detail || "");
  if (ordinal && Number(ordinal[1]) > 0 && Number(ordinal[1]) <= rows.length)
    return Number(ordinal[1]) - 1;
  return safeFallback;
}
