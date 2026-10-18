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
