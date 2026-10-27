import test from "node:test";
import assert from "node:assert/strict";
import {
  remainingSeconds,
  elapsedSeconds,
  questionNavigation,
  questionNavigationEntries,
  navigationEntryProgress,
  navigationEntryMarked,
  toggleNavigationEntryMark,
  scrollQuestionWithinPane,
  answeredQuestion,
  optionFromDrop,
  examDraftKey,
  validSession,
} from "../apps/web/src/lib/computer-test.mjs";
import { buildGroups } from "../apps/web/src/lib/questions.mjs";
test("deadline clock remains correct after background suspension and expires at zero", () => {
  assert.equal(remainingSeconds(null, 10000), null);
  assert.equal(remainingSeconds(60000, 10000), 50);
  assert.equal(remainingSeconds(60000, 59999), 1);
  assert.equal(remainingSeconds(60000, 120000), 0);
  assert.equal(elapsedSeconds(0, 120000, 60000), 60);
  assert.equal(elapsedSeconds(0, 120000, null), 120);
});
test("scoring slots remain separate while a multi-select task has one navigation entry and answer key", () => {
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
  const entries = questionNavigationEntries(groups);
  assert.deepEqual(
    entries.map((entry) => entry.label),
    ["6–7"],
  );
  assert.equal(entries[0].rowId, row.id);
  assert.deepEqual(navigationEntryProgress(entries[0], row, {}), {
    answered: 0,
    total: 2,
    complete: false,
  });
  assert.deepEqual(navigationEntryProgress(entries[0], row, { "0:0": ["0"] }), {
    answered: 1,
    total: 2,
    complete: false,
  });
  assert.deepEqual(
    navigationEntryProgress(entries[0], row, { "0:0": ["0", "2"] }),
    {
      answered: 2,
      total: 2,
      complete: true,
    },
  );
  assert.equal(answeredQuestion(nav[0], row, { "0:0": ["0"] }), true);
  assert.equal(answeredQuestion(nav[1], row, { "0:0": ["0"] }), false);
  assert.equal(answeredQuestion(nav[1], row, { "0:0": ["0", "2"] }), true);
});
test("legacy per-slot review marks map to one task and toggle without altering other tasks", () => {
  const entry = {
    number: 6,
    endNumber: 7,
    label: "6–7",
    rowId: "0:0",
    groupId: "0",
    offset: 0,
  };
  const savedMarks = [2, 7, 9];
  assert.equal(navigationEntryMarked(entry, savedMarks), true);
  assert.deepEqual(toggleNavigationEntryMark(entry, savedMarks), [2, 9]);
  assert.deepEqual(savedMarks, [2, 7, 9]);
  assert.deepEqual(toggleNavigationEntryMark(entry, [2, 6, 7, 9]), [2, 9]);
  assert.deepEqual(toggleNavigationEntryMark(entry, [2, 9]), [2, 9, 6]);
  assert.equal(navigationEntryMarked(entry, [2, 9]), false);
});
test("two blanks sharing one score remain one numbered task and require both blanks", () => {
  const groups = buildGroups({
    questions: [
      {
        questionJson: { questionType: "0", startIndex: 3, questionNum: 1 },
        answerJson: [{ correctValue: "morning|evening" }],
      },
    ],
  });
  const [entry] = questionNavigationEntries(groups),
    row = groups[0].rows[0];
  assert.equal(entry.label, "3");
  assert.deepEqual(
    navigationEntryProgress(entry, row, { [row.id]: ["morning", ""] }),
    { answered: 0, total: 1, complete: false },
  );
  assert.deepEqual(
    navigationEntryProgress(entry, row, { [row.id]: ["morning", "evening"] }),
    { answered: 1, total: 1, complete: true },
  );
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
    await import("../apps/web/src/lib/computer-test.mjs");
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

test("keyboard question navigation stays within its visible part and does not consume answer-editing keys", async () => {
  const { navigationDestination } =
    await import("../apps/web/src/lib/computer-test.mjs");
  const numbers = [11, 12, 13, 14];
  assert.equal(navigationDestination(numbers, 12, "ArrowRight"), 13);
  assert.equal(navigationDestination(numbers, 12, "ArrowLeft"), 11);
  assert.equal(navigationDestination(numbers, 11, "ArrowLeft"), 11);
  assert.equal(navigationDestination(numbers, 14, "ArrowRight"), 14);
  assert.equal(navigationDestination(numbers, 13, "Home"), 11);
  assert.equal(navigationDestination(numbers, 13, "End"), 14);
  assert.equal(navigationDestination(numbers, 13, "Tab"), null);
  assert.equal(navigationDestination(numbers, 13, "a"), null);
  assert.equal(navigationDestination([], 13, "ArrowRight"), null);
});
test("keyboard split resizing respects readable bounds and an explicit equal-width reset", async () => {
  const { splitByKeyboard } = await import("../apps/web/src/lib/computer-test.mjs");
  assert.equal(splitByKeyboard(50, "ArrowLeft"), 48);
  assert.equal(splitByKeyboard(50, "ArrowRight"), 52);
  assert.equal(splitByKeyboard(30, "ArrowLeft"), 30);
  assert.equal(splitByKeyboard(70, "ArrowRight"), 70);
  assert.equal(splitByKeyboard(50, "Home"), 30);
  assert.equal(splitByKeyboard(50, "End"), 70);
  assert.equal(splitByKeyboard(34, "Enter"), 50);
  assert.equal(splitByKeyboard(50, "Tab"), null);
});
test("question jumps scroll only the question pane and clamp tall or edge targets", () => {
  const target = {
    top: 900,
    height: 80,
    getBoundingClientRect() {
      return { top: this.top, height: this.height };
    },
    scrollIntoView() {
      throw new Error("Must not scroll ancestors");
    },
  };
  const outer = { scrollTop: 0 };
  const passage = { scrollTop: 240 };
  const pane = {
    scrollTop: 0,
    scrollLeft: 9,
    clientTop: 1,
    clientHeight: 420,
    scrollHeight: 1600,
    contains: (element) => element === target,
    getBoundingClientRect: () => ({ top: 140 }),
    scrollTo: (options) => {
      pane.scrollTop = options.top;
      assert.equal(options.left, 9);
    },
  };
  assert.equal(scrollQuestionWithinPane(pane, target), true);
  assert.equal(pane.scrollTop, 589);
  assert.equal(outer.scrollTop, 0);
  assert.equal(passage.scrollTop, 240);
  target.top = 1600;
  target.height = 600;
  scrollQuestionWithinPane(pane, target);
  assert.equal(pane.scrollTop, 1180);
  target.top = -2000;
  scrollQuestionWithinPane(pane, target);
  assert.equal(pane.scrollTop, 0);
  assert.equal(scrollQuestionWithinPane(pane, {}), false);
  assert.equal(scrollQuestionWithinPane(null, target), false);
});
