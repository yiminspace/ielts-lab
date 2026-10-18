import test from "node:test";
import assert from "node:assert/strict";
import {
  remainingSeconds,
  elapsedSeconds,
  questionNavigation,
  answeredQuestion,
  optionFromDrop,
  examDraftKey,
  validSession,
} from "../src/lib/computer-test.mjs";
import { buildGroups } from "../src/lib/questions.mjs";
test("deadline clock remains correct after background suspension and expires at zero", () => {
  assert.equal(remainingSeconds(null, 10000), null);
  assert.equal(remainingSeconds(60000, 10000), 50);
  assert.equal(remainingSeconds(60000, 59999), 1);
  assert.equal(remainingSeconds(60000, 120000), 0);
  assert.equal(elapsedSeconds(0, 120000, 60000), 60);
  assert.equal(elapsedSeconds(0, 120000, null), 120);
});
test("individual question navigation expands a multi-select row without changing answer keys", () => {
  const groups = buildGroups({
    questions: [
      {
        questionJson: {
          questionType: "2",
          startIndex: 6,
          endIndex: 7,
          questionNum: 2,
          questions: [
            {
              number: 2,
              content: "Choose two",
              options: [
                { content: "one" },
                { content: "two" },
                { content: "three" },
              ],
            },
          ],
        },
        answerJson: [{ correctValue: [0, 2] }],
      },
    ],
  });
  const nav = questionNavigation(groups);
  assert.deepEqual(
    nav.map((x) => x.number),
    [6, 7],
  );
  assert.equal(nav[0].rowId, nav[1].rowId);
  const row = groups[0].rows[0];
  assert.equal(answeredQuestion(nav[0], row, { "0:0": ["0"] }), true);
  assert.equal(answeredQuestion(nav[1], row, { "0:0": ["0"] }), false);
  assert.equal(answeredQuestion(nav[1], row, { "0:0": ["0", "2"] }), true);
});
test("matching drops only accept values from the matching option group", () => {
  const options = [{ value: "0" }, { value: "1" }];
  assert.equal(
    optionFromDrop(JSON.stringify({ groupId: "a", value: "1" }), "a", options),
    "1",
  );
  assert.equal(
    optionFromDrop(JSON.stringify({ groupId: "b", value: "1" }), "a", options),
    null,
  );
  assert.equal(
    optionFromDrop(JSON.stringify({ groupId: "a", value: "99" }), "a", options),
    null,
  );
  assert.equal(optionFromDrop("https://example.invalid/", "a", options), null);
});
test("computer test sessions use separate drafts and reject incompatible saved state", () => {
  assert.equal(examDraftKey("demo-reading"), "exam:demo-reading");
  assert.equal(
    validSession({ answers: {}, elapsed: 1, submitted: false }),
    false,
  );
  assert.equal(
    validSession({ version: 1, answers: {}, startedAt: 100, phase: "active" }),
    true,
  );
  assert.equal(
    validSession({
      version: 1,
      answers: null,
      startedAt: 100,
      phase: "active",
    }),
    false,
  );
});

test("a stale tab cannot replace a newer same-session save, but an owner can save successive revisions", async () => {
  const { sessionSignature, prepareSessionSave } =
    await import("../src/lib/computer-test.mjs");
  const original = {
    version: 1,
    runId: "one",
    revision: 1,
    answers: { "0:0": "first" },
    startedAt: 1,
    phase: "active",
  };
  const tabA = sessionSignature(original),
    tabB = sessionSignature(original);
  const next = prepareSessionSave(original, tabA, {
    ...original,
    answers: { "0:0": "newer" },
  });
  assert.equal(next.revision, 2);
  assert.equal(
    prepareSessionSave(next, tabB, {
      ...original,
      answers: { "0:0": "stale" },
    }),
    null,
  );
  assert.equal(
    prepareSessionSave(next, sessionSignature(next), {
      ...next,
      notes: "owner note",
    }).revision,
    3,
  );
  assert.equal(
    prepareSessionSave(
      { ...next, runId: "another-run" },
      sessionSignature(next),
      next,
    ),
    null,
  );
});
