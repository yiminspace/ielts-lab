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
test("overlapping context includes the opening and closing", () => {
  const { segments, error } = listeningSegments(source());
  assert.equal(error, "");
  assert.deepEqual(
    segments.map(({ start, end }) => [start, end]),
    [
      [0, 40],
      [0, 40],
      [5, 40],
    ],
  );
  assert.deepEqual(
    segments[0].lines.map((line) => line.text),
    [
      "Introduction",
      "First answer",
      "Second answer",
      "Third answer",
      "Closing",
    ],
  );
  assert.equal(segments.at(-1).lines.at(-1).text, "Closing");
});
test("answers in the same sentence share a segment without zero length clips", () => {
  const { segments } = listeningSegments(source([2, 2, 4]));
  assert.deepEqual(
    segments.map(({ start, end }) => [start, end]),
    [
      [0, 40],
      [5, 40],
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

test("all multi-answer hints receive context, including later evidence phrases", () => {
  const data = source([4, 11]);
  data.seconds = 150;
  data.listenDetail = Array.from(
    { length: 15 },
    (_, i) =>
      `[${String(Math.floor(i / 6)).padStart(2, "0")}:${String((i % 6) * 10).padStart(2, "0")}]Original line ${i + 1}.`,
  ).join("\n");
  const answers = JSON.parse(data.questions[0].answerJson);
  answers[0].sentenceList = [4, 6];
  answers[0].positionSentence = "Original line 4.; Original line 8.";
  data.questions[0].answerJson = JSON.stringify(answers);
  const { segments } = listeningSegments(data);
  assert.equal(segments[0].lines.at(-1).text, "Original line 11.");
  assert.equal(segments[1].lines[0].text, "Original line 9.");
  assert.ok(segments[0].end > segments[1].start);
  for (const [i, evidence] of [
    [0, [3, 5, 7]],
    [1, [10]],
  ]) {
    const segment = segments[i];
    for (const index of evidence) {
      assert.ok(segment.start < index * 10);
      assert.ok(segment.end > (index + 1) * 10);
    }
  }
});

test("context windows cover every transcript line even with widely spaced answers", () => {
  const data = source([3, 18]);
  data.seconds = 200;
  data.listenDetail = Array.from(
    { length: 20 },
    (_, i) =>
      `[${String(Math.floor(i / 6)).padStart(2, "0")}:${String((i % 6) * 10).padStart(2, "0")}]Original line ${i + 1}.`,
  ).join("\n");
  const { segments } = listeningSegments(data);
  assert.equal(
    new Set(segments.flatMap((s) => s.lines.map((l) => l.start))).size,
    20,
  );
  assert.ok(segments[0].end >= segments[1].start);
});

test("a blank timing marker ends the last context sentence before a long pause", () => {
  const data = source([2, 9]);
  data.seconds = 130;
  data.listenDetail = [
    "[00:00]Introduction",
    "[00:05]First answer",
    "[00:10]Explanation",
    "[00:15]Alternative",
    "[00:20]Final qualification",
    "[00:25]",
    "[01:00]Next topic",
    "[01:10]Next introduction",
    "[01:20]Next detail",
    "[01:30]Second answer",
    "[01:40]Closing",
  ].join("\n");
  const { segments } = listeningSegments(data);
  assert.equal(segments[0].lines.at(-1).text, "Final qualification");
  assert.equal(segments[0].end, 25);
});
