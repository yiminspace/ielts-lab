import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGroups,
  gradeGroups,
  assessRow,
  normalizeAnswer,
  parseTranscript,
  displayAnswer,
  answerQuotes,
} from "../src/lib/questions.mjs";
// Original synthetic examples model the observed archive schemas without reproducing source questions.
function group(type, question, answers, start = 1, count = answers.length) {
  return buildGroups({
    questions: [
      {
        questionJson: {
          questionType: type,
          startIndex: start,
          endIndex: start + count - 1,
          questionNum: count,
          ...question,
        },
        answerJson: answers.map((correctValue) => ({ correctValue })),
      },
    ],
  })[0];
}
test("text comparison normalizes case, Unicode punctuation and spacing without accepting substrings", () => {
  const row = group("0", {}, ["theatre/theater"]).rows[0];
  assert.equal(assessRow(row, " Theater ").status, "correct");
  assert.equal(assessRow(row, "the theatre").status, "incorrect");
  assert.equal(assessRow(row, "").status, "blank");
  assert.equal(normalizeAnswer(" twenty‑one  "), "twenty-one");
});
test("two-part blanks require both answers, allow reversed order, and preserve one question weight", () => {
  const row = group("0", {}, ["morning|evening/night"]).rows[0];
  assert.equal(row.slots, 2);
  assert.equal(assessRow(row, ["night", "morning"]).earned, 1);
  assert.equal(assessRow(row, ["morning", "morning"]).earned, 0);
  assert.equal(assessRow(row, ["morning", ""]).earned, 0);
});
test("ambiguous multi-separator standard answer requests manual review", () => {
  const row = group("0", {}, ["dates|times/times|dates"]).rows[0];
  assert.equal(assessRow(row, "dates").status, "manual");
});
test("single-choice and judgment answers use zero-based option indices", () => {
  const q = {
    questions: [
      {
        content: "Sample statement",
        number: 1,
        options: [
          { content: "TRUE" },
          { content: "FALSE" },
          { content: "NOT GIVEN" },
        ],
      },
    ],
  };
  const row = group("3", q, [0], 15).rows[0];
  assert.equal(row.number, 15);
  assert.equal(assessRow(row, "0").earned, 1);
  assert.equal(assessRow(row, "1").earned, 0);
  assert.equal(displayAnswer(row), "TRUE");
  assert.equal(assessRow({ ...row, expected: 7 }, "7").status, "manual");
});
test("multi-select has unordered, unique selection and bounded partial credit per answer slot", () => {
  const q = {
    questions: [
      {
        content: "Choose two",
        number: 2,
        options: Array.from({ length: 5 }, (_, i) => ({
          content: `Example ${i}`,
        })),
      },
    ],
  };
  const g = group("2", q, [[1, 3]], 21, 2);
  const row = g.rows[0];
  assert.equal(row.endNumber, 22);
  assert.equal(assessRow(row, ["3", "1"]).earned, 2);
  assert.equal(assessRow(row, ["1", "2"]).earned, 1);
  assert.equal(assessRow(row, ["1", "1"]).earned, 1);
  assert.equal(assessRow(row, ["0", "1", "2", "3"]).earned, 0);
  assert.equal(gradeGroups([g], { [row.id]: ["3", "1"] }).total, 2);
});
test("matching supports Roman labels while storing indices independently", () => {
  const row = group(
    "4",
    {
      matchOptions: [{ content: "Topic one" }, { content: "Topic two" }],
      indexType: "roma",
    },
    [1],
    9,
  ).rows[0];
  assert.equal(displayAnswer(row), "ii");
  assert.equal(assessRow(row, "1").earned, 1);
  assert.equal(assessRow(row, "ii").earned, 0);
});
test("unknown types and absent answer keys never count as automatically correct", () => {
  const row = group("novel", {}, ["x"]).rows[0];
  assert.equal(assessRow(row, "x").status, "manual");
  const noKey = buildGroups({
    questions: [
      {
        questionJson: { questionType: "0", startIndex: 1, questionNum: 1 },
        answerJson: [],
      },
    ],
  });
  assert.equal(gradeGroups(noKey, { "0:0": "hello" }).manual, 1);
});
test("transcript timestamps retain pause boundaries and bilingual content", () => {
  const lines = parseTranscript(
    "[00:01.25]A sample sentence.##例句。\n[00:04.00]\n[00:08.50]Another sentence.##另一句。",
    12,
  );
  assert.equal(lines.length, 2);
  assert.equal(lines[0].start, 1.25);
  assert.equal(lines[0].end, 4);
  assert.equal(lines[1].end, 12);
  assert.equal(lines[0].translation, "例句。");
});
test("reading evidence extraction handles empty metadata and deduplicates quotations", () => {
  assert.deepEqual(answerQuotes({}), []);
  assert.deepEqual(
    answerQuotes({
      articleSourceHighlight: {
        data: [
          { a: { text: "Original example" } },
          { b: { text: "Original example" } },
        ],
      },
    }),
    ["Original example"],
  );
});

test("an explicitly blank submitted answer displays as blank rather than the key", () => {
  const row = group("0", {}, ["sample"]).rows[0];
  assert.equal(displayAnswer(row), "sample");
  assert.equal(displayAnswer(row, ""), "");
  const option = group(
    "1",
    {
      questions: [
        { content: "Example", number: 1, options: [{ content: "First" }] },
      ],
    },
    [0],
  ).rows[0];
  assert.equal(displayAnswer(option, ""), "");
});

test("bundled demonstration retains listening prompt context and reading passage alongside all five types", async () => {
  const { demoItems } = await import("../server/demo.mjs");
  const listening = demoItems.find((item) => item.kind === "listening");
  const reading = demoItems.find((item) => item.kind === "reading");
  const listeningGroups = buildGroups(listening.data);
  const readingGroups = buildGroups(reading.data);
  assert.ok(
    listeningGroups[0].content.includes("Meeting day"),
    "Listening prompt must remain attached to its answer blanks",
  );
  assert.ok(listeningGroups[0].content.includes("Monthly cost"));
  assert.ok(listeningGroups[0].content.includes("Meeting place"));
  assert.ok(listeningGroups[0].content.includes("Register by"));
  assert.equal((listeningGroups[0].content.match(/\.{6}/g) || []).length, 4);
  assert.ok(
    reading.data.passagesContent?.includes("neighbourhood library"),
    "Reading passage must use the observed archive field",
  );
  assert.deepEqual(
    [
      ...new Set(
        [...listeningGroups, ...readingGroups].map((group) => group.type),
      ),
    ].sort(),
    ["0", "1", "2", "3", "4"],
  );
  for (const group of [...listeningGroups, ...readingGroups]) {
    if (["0", "4"].includes(group.type))
      assert.ok(
        group.content.trim(),
        "Gap/matching groups need their original context",
      );
    else
      for (const row of group.rows) {
        assert.ok(row.content.trim());
        assert.ok(row.options.length);
      }
  }
});
