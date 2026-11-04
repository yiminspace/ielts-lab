/** Opt in to a diagram matrix only when each numbered label maps unambiguously
 * to one answer. Keep unfamiliar source layouts on the existing fallback. */
export function diagramMatchingMatrix(group) {
  if (group.type !== "4" || !group.optionsImage || !group.rows.length)
    return null;
  const options = group.rows[0].options;
  if (
    options.length < 2 ||
    options.length > 12 ||
    options.some(
      (option, index) =>
        option.label !== String.fromCharCode(65 + index) ||
        String(option.content)
          .replace(/<[^>]*>/g, "")
          .trim(),
    ) ||
    group.rows.some(
      (row) =>
        row.slots !== 1 ||
        row.options.length !== options.length ||
        row.options.some(
          (option, index) =>
            option.value !== options[index].value ||
            option.label !== options[index].label,
        ),
    )
  )
    return null;
  const source = String(group.content || "");
  if (/<\/?(?:table|img|script|style|iframe)\b/i.test(source)) return null;
  const lines = source
    .replace(/<br\s*\/?\s*>|<\/?(?:div|p|li|ul|ol)\b[^>]*>/gi, "\n")
    .replace(/&nbsp;|&#160;/gi, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== group.rows.length) return null;
  const rows = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/<[^>]*>/g, "");
    const match = line.match(/^\s*(\d+)[.)]?\s+(.+?)\s*\.{6}\s*$/);
    if (!match || Number(match[1]) !== group.rows[index].number) return null;
    rows.push({ rowId: group.rows[index].id, html: match[2] });
  }
  return { options, rows };
}
