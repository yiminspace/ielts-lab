import { buildGroups } from "./questions.mjs";
/** Local familiarisation session rules; these do not represent official test timing. */
export function remainingSeconds(deadline, now = Date.now()) {
  if (deadline == null) return null;
  if (!Number.isFinite(deadline) || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}
export function elapsedSeconds(startedAt, now = Date.now(), deadline = null) {
  if (!Number.isFinite(startedAt)) return 0;
  const end = Number.isFinite(deadline) ? Math.min(now, deadline) : now;
  return Math.max(0, Math.floor((end - startedAt) / 1000));
}
export function questionNavigation(groups) {
  return groups.flatMap((group) =>
    group.rows.flatMap((row) =>
      Array.from(
        { length: Math.max(1, row.endNumber - row.number + 1) },
        (_, offset) => ({
          number: row.number + offset,
          rowId: row.id,
          groupId: group.id,
          offset,
        }),
      ),
    ),
  );
}
export function answeredQuestion(nav, row, answers) {
  const answer = answers[row.id];
  if (row.type === "2")
    return Array.isArray(answer) && answer.length > nav.offset;
  if (row.slots > 1)
    return (
      Array.isArray(answer) &&
      answer.length >= row.slots &&
      answer.every((value) => String(value).trim())
    );
  return typeof answer === "string" && answer.trim().length > 0;
}
export function optionFromDrop(payload, groupId, options) {
  try {
    const parsed = JSON.parse(payload);
    return parsed.groupId === groupId &&
      options.some((option) => option.value === String(parsed.value))
      ? String(parsed.value)
      : null;
  } catch {
    return null;
  }
}
export function examDraftKey(itemId) {
  return `exam:${itemId}`;
}
export function validSession(value) {
  return (
    !!value &&
    value.version === 1 &&
    typeof value.answers === "object" &&
    !Array.isArray(value.answers) &&
    value.answers !== null &&
    Number.isFinite(value.startedAt) &&
    ["active", "submission", "complete"].includes(value.phase)
  );
}
export function sessionSignature(value) {
  return JSON.stringify(value ?? null);
}
export function prepareSessionSave(current, expectedSignature, proposed) {
  if (sessionSignature(current) !== expectedSignature) return null;
  return { ...proposed, revision: (Number(current?.revision) || 0) + 1 };
}

/** Change only a declared question-number prefix in the block containing its gap.
 * Ordinary quantities/dates elsewhere in the source text are left untouched. */
export function renumberGapPrefixes(html, originalRows, normalizedRows) {
  const source = String(html || "");
  const sourceSlots = originalRows.flatMap((row) =>
    Array.from({ length: row.slots }, () => row),
  );
  const targetSlots = normalizedRows.flatMap((row) =>
    Array.from({ length: row.slots }, () => row),
  );
  const pieces = source.split("......");
  if (
    pieces.length - 1 !== sourceSlots.length ||
    sourceSlots.length !== targetSlots.length
  )
    return source;
  for (let index = 0; index < sourceSlots.length; index++) {
    const piece = pieces[index];
    const openings = [...piece.matchAll(/<(?:p|li|td|th|div)\b[^>]*>/gi)];
    const opening = openings.at(-1);
    const blockStart = opening ? opening.index + opening[0].length : 0;
    const prefix = piece.slice(blockStart);
    const match = prefix.match(
      /^(\s*(?:<(?:b|strong|em|i|span)\b[^>]*>\s*)*)(\d+)([a-z]?)(\s*(?:<\/(?:b|strong|em|i|span)>\s*)*[.)])(?!\d)/i,
    );
    if (match && Number(match[2]) === sourceSlots[index].number) {
      const numberStart = blockStart + match[1].length;
      pieces[index] =
        piece.slice(0, numberStart) +
        targetSlots[index].number +
        piece.slice(numberStart + match[2].length);
    }
  }
  return pieces.join("......");
}
/** Re-number separate archive parts and keep their answer keys independent. */
export function paperParts(items) {
  let nextNumber = 1;
  return items.map((item, partIndex) => {
    const data = item.data?.data?.questions ? item.data.data : item.data || {};
    const originalGroups = buildGroups(data);
    const prefix = `${encodeURIComponent(item.id)}::`;
    const groups = originalGroups.map((group) => {
      const start = nextNumber;
      const rows = group.rows.map((row) => {
        const width = Math.max(1, row.endNumber - row.number + 1);
        const number = nextNumber;
        nextNumber += width;
        return {
          ...row,
          id: prefix + row.id,
          number,
          endNumber: nextNumber - 1,
        };
      });
      return {
        ...group,
        id: prefix + group.id,
        content: renumberGapPrefixes(group.content, group.rows, rows),
        start,
        end: nextNumber - 1,
        rows,
      };
    });
    const navigation = questionNavigation(groups);
    return {
      itemId: item.id,
      partIndex,
      prefix,
      originalGroups,
      groups,
      first: navigation[0]?.number || nextNumber,
      last: navigation.at(-1)?.number || nextNumber - 1,
    };
  });
}
export function answersForPart(part, answers) {
  return Object.fromEntries(
    part.originalGroups
      .flatMap((group) => group.rows)
      .filter((row) => Object.hasOwn(answers, part.prefix + row.id))
      .map((row) => [row.id, answers[part.prefix + row.id]]),
  );
}
export function paperDraftKey(paperId, runId, kind) {
  return `paper:${paperId}:${runId}:${kind}`;
}
export function paperReadingDeadline(startedAt) {
  return startedAt + 60 * 60 * 1000;
}
/** An error is not an ended event: no skipped audio and no review deadline. */
export function advancePaperAudio(
  state,
  eventIndex,
  count,
  now,
  successful = true,
) {
  const index = state.audioIndex || 0;
  if (!successful || state.audioEnded || eventIndex !== index || count < 1)
    return null;
  if (index + 1 < count)
    return {
      audioIndex: index + 1,
      audioPosition: 0,
      audioEnded: false,
      deadline: null,
    };
  return {
    audioIndex: index,
    audioPosition: 0,
    audioEnded: true,
    deadline: state.deadline ?? now + 120000,
  };
}
export function validatePaperParts(items, parts, kind, shortDemo = false) {
  if (items.length !== (kind === "listening" ? 4 : 3))
    return "The paper has an incomplete set of parts.";
  if (new Set(items.map((item) => item.id)).size !== items.length)
    return "The paper repeats a material ID.";
  if (
    items.some((item) => item.kind !== kind) ||
    parts.some((part) => !part.groups.length || part.last < part.first)
  )
    return "One or more parts contain no compatible questions.";
  const count = parts.reduce(
    (sum, part) => sum + part.last - part.first + 1,
    0,
  );
  if (!shortDemo && count !== 40)
    return `This paper contains ${count} questions; a complete paper needs 40.`;
  return "";
}

/** Keyboard movement stays in the visible navigation group and never wraps. */
export function navigationDestination(numbers, current, key) {
  if (!numbers.length) return null;
  const index = numbers.indexOf(current);
  if (key === "Home") return numbers[0];
  if (key === "End") return numbers.at(-1);
  if (key === "ArrowLeft") return numbers[Math.max(0, index - 1)];
  if (key === "ArrowRight")
    return numbers[Math.min(numbers.length - 1, Math.max(0, index) + 1)];
  return null;
}
export function splitByKeyboard(current, key) {
  if (key === "Home") return 30;
  if (key === "End") return 70;
  if (key === "Enter") return 50;
  if (key === "ArrowLeft") return Math.max(30, current - 2);
  if (key === "ArrowRight") return Math.min(70, current + 2);
  return null;
}
