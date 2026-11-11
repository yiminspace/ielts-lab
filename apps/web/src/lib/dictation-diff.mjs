/** Word-level comparison. Normalize case/punctuation for matching, retain original spelling for display. */
export function dictationDiff(reference, text) {
  const expected = String(reference).match(/\S+/gu) || [];
  const actual = String(text).match(/\S+/gu) || [];
  const key = (word) =>
    word.toLocaleLowerCase("en").replace(/[\p{P}\p{S}]/gu, "");
  if (expected.length * actual.length > 250000)
    return [
      ...actual.map((text) => ({ type: "extra", text })),
      ...expected.map((text) => ({ type: "missing", text })),
    ];
  const lengths = Array.from(
    { length: expected.length + 1 },
    () => new Uint16Array(actual.length + 1),
  );
  for (let i = expected.length - 1; i >= 0; i--)
    for (let j = actual.length - 1; j >= 0; j--)
      lengths[i][j] =
        key(expected[i]) === key(actual[j])
          ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
  const result = [];
  let i = 0,
    j = 0;
  while (i < expected.length || j < actual.length) {
    if (
      i < expected.length &&
      j < actual.length &&
      key(expected[i]) === key(actual[j])
    ) {
      result.push({ type: "equal", text: expected[i++] });
      j++;
    } else if (
      j < actual.length &&
      (i === expected.length || lengths[i][j + 1] >= lengths[i + 1][j])
    ) {
      result.push({ type: "extra", text: actual[j++] });
    } else result.push({ type: "missing", text: expected[i++] });
  }
  return result;
}
