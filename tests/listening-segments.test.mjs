import test from "node:test";
import assert from "node:assert/strict";
import { listeningSegments } from "../apps/web/src/lib/listening-segments.mjs";

function source(positions = [2, 3, 4]) {
  return {
    seconds: 40,
    listenDetail:
      "[00:00]Introduction\n[00:05]First answer\n[00:15]Second answer\n[00:25]Third answer\n[00:35]Closing",
    questions: [
      {
        questionJson: JSON.stringify({
          questionType: 0,
          questionNum: positions.length,
          startIndex: 1,
        }),
        answerJson: JSON.stringify(
          positions.map((position) => ({
            correctValue: "original",
            sentenceList: [position],
          })),
        ),
      },
    ],
  };
}
test("continuous answer boundaries include the opening and closing", () => {
  const { segments, error } = listeningSegments(source());
  assert.equal(error, "");
  assert.deepEqual(
    segments.map(({ start, end }) => [start, end]),
    [
      [0, 15],
      [15, 25],
      [25, 40],
    ],
  );
  assert.deepEqual(
    segments[0].lines.map((line) => line.text),
    ["Introduction", "First answer"],
  );
  assert.equal(segments.at(-1).lines.at(-1).text, "Closing");
});
test("answers in the same sentence share a segment without zero length clips", () => {
  const { segments } = listeningSegments(source([2, 2, 4]));
  assert.deepEqual(
    segments.map(({ start, end }) => [start, end]),
    [
      [0, 25],
      [25, 40],
    ],
  );
  assert.equal(segments[0].entries.length, 2);
});
test("missing and backwards locations never fabricate boundaries", () => {
  for (const positions of [
    [2, 99, 4],
    [3, 2, 4],
  ]) {
    const result = listeningSegments(source(positions));
    assert.ok(result.error);
    assert.deepEqual(result.segments, []);
  }
});
test("media metadata supplies the last boundary; unknown duration runs to ended", () => {
  const data = source();
  delete data.seconds;
  assert.equal(listeningSegments(data).segments.at(-1).end, null);
  assert.equal(listeningSegments(data, 44).segments.at(-1).end, 44);
});
test("single question covers the whole recording", () => {
  assert.deepEqual(
    listeningSegments(source([2])).segments.map(({ start, end }) => [
      start,
      end,
    ]),
    [[0, 40]],
  );
});
