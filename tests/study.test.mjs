import test from "node:test";
import assert from "node:assert/strict";
import {
  countWords,
  checkDictation,
  typingMetrics,
  formatTime,
  reviewIndex,
} from "../apps/web/src/lib/study.mjs";

test("word count handles contractions, punctuation and whitespace", () => {
  assert.equal(countWords("  It's a well-known idea.\nThree examples! "), 6);
  assert.equal(countWords(""), 0);
});

test("sentence dictation tolerates case and terminal punctuation but preserves word differences", () => {
  assert.ok(checkDictation("  I’m ready! ", "I'm ready."));
  assert.ok(!checkDictation("I am ready", "I was ready"));
  assert.ok(!checkDictation("", ""));
  assert.ok(!checkDictation("15", "1.5"));
});

test("number dictation tolerates grouping and phone separators but preserves decimal points", () => {
  assert.ok(checkDictation("1,250", "1250", "numbers"));
  assert.ok(checkDictation("AB-120 890", "AB120890", "numbers"));
  assert.ok(!checkDictation("1250", "12.50", "numbers"));
});

test("typing completion requires exact text and penalizes incorrect extra characters", () => {
  assert.deepEqual(typingMetrics("Hello", "Hello", 30), {
    correct: 5,
    accuracy: 100,
    wpm: 2,
    progress: 100,
    complete: true,
  });
  assert.equal(typingMetrics("Hello!", "Hello", 30).complete, false);
  assert.equal(typingMetrics("Hallo", "Hello", 30).accuracy, 80);
  assert.equal(typingMetrics("", "Hello", 0).wpm, 0);
  assert.equal(formatTime(125), "02:05");
});

test("historical reviews locate the answered row instead of the latest draft position", () => {
  const sentences = [
    { sentenceId: "sentence-one" },
    { sentenceId: "sentence-two" },
    { sentenceId: "sentence-three" },
  ];
  assert.equal(
    reviewIndex(
      sentences,
      { answers: { "sentence-one": "old answer" } },
      "sentences",
      2,
    ),
    0,
  );
  assert.equal(
    reviewIndex(
      [{ wordId: "a" }, { wordId: "b" }],
      { answers: { b: "word" } },
      "vocabulary",
      0,
    ),
    1,
  );
  assert.equal(
    reviewIndex(
      [{ id: 100 }, { id: 200 }],
      { answers: { 200: "123" } },
      "numbers",
      0,
    ),
    1,
  );
  assert.equal(
    reviewIndex(sentences, { detail: "第 2 条需要复习" }, "sentences", 0),
    1,
  );
  assert.equal(reviewIndex(sentences, undefined, "sentences", 2), 2);
  assert.equal(
    reviewIndex(sentences, { answers: { missing: "value" } }, "sentences", 99),
    2,
  );
});
