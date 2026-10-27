export function writingSplit(value) {
  return Math.max(
    30,
    Math.min(70, Number.isFinite(Number(value)) ? Number(value) : 50),
  );
}

export function resizeWritingSplit(current, key) {
  if (key === "Home") return 30;
  if (key === "End") return 70;
  if (key === "ArrowLeft") return writingSplit(current - 2);
  if (key === "ArrowRight") return writingSplit(current + 2);
  return writingSplit(current);
}

export function writingHighlightRanges(value) {
  const ranges = (Array.isArray(value) ? value : [])
    .filter(
      (range) =>
        Number.isInteger(range?.start) &&
        Number.isInteger(range?.end) &&
        range.start >= 0 &&
        range.end > range.start,
    )
    .map(({ start, end }) => ({ start, end }))
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end)
      previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

export function changeWritingHighlight(existing, selected, action) {
  const ranges = writingHighlightRanges(existing);
  const selection = writingHighlightRanges([selected])[0];
  if (!selection) return ranges;
  if (action === "add") return writingHighlightRanges([...ranges, selection]);
  return ranges.flatMap((range) => {
    if (range.end <= selection.start || range.start >= selection.end)
      return [range];
    return [
      ...(range.start < selection.start
        ? [{ start: range.start, end: selection.start }]
        : []),
      ...(range.end > selection.end
        ? [{ start: selection.end, end: range.end }]
        : []),
    ];
  });
}
