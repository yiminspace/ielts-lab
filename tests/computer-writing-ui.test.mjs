import test from "node:test";
import assert from "node:assert/strict";
import {
  writingSplit,
  resizeWritingSplit,
  writingHighlightRanges,
  changeWritingHighlight,
} from "../apps/web/src/lib/computer-writing-ui.mjs";
import {
  restorePaperWriting,
  switchPaperWritingTask,
  editPaperWriting,
  finishPaperWriting,
} from "../apps/web/src/lib/computer-writing-paper.mjs";

test("writing splitter pointer and keyboard sizing keep both panes readable", () => {
  assert.equal(writingSplit(-100), 30);
  assert.equal(writingSplit(1000), 70);
  assert.equal(writingSplit(Number.NaN), 50);
  assert.equal(writingSplit(45.5), 45.5);
  assert.equal(resizeWritingSplit(50, "ArrowLeft"), 48);
  assert.equal(resizeWritingSplit(50, "ArrowRight"), 52);
  assert.equal(resizeWritingSplit(69, "ArrowRight"), 70);
  assert.equal(resizeWritingSplit(31, "ArrowLeft"), 30);
  assert.equal(resizeWritingSplit(50, "Home"), 30);
  assert.equal(resizeWritingSplit(50, "End"), 70);
  assert.equal(resizeWritingSplit(50, "Escape"), 50);
});

test("highlight ranges discard malformed data and merge overlapping selections without mutating saved data", () => {
  const existing = [
    { start: 10, end: 20 },
    { start: 0, end: 4 },
  ];
  assert.deepEqual(
    writingHighlightRanges([
      ...existing,
      { start: 3, end: 11 },
      { start: -1, end: 3 },
      { start: 10, end: 10 },
      { start: "20", end: 30 },
      null,
    ]),
    [{ start: 0, end: 20 }],
  );
  assert.deepEqual(
    changeWritingHighlight(existing, { start: 4, end: 10 }, "add"),
    [{ start: 0, end: 20 }],
  );
  assert.deepEqual(existing, [
    { start: 10, end: 20 },
    { start: 0, end: 4 },
  ]);
  assert.deepEqual(writingHighlightRanges({}), []);
});

test("clearing a selection only removes its overlap and retains the remaining highlighted text", () => {
  assert.deepEqual(
    changeWritingHighlight(
      [{ start: 0, end: 20 }],
      { start: 5, end: 10 },
      "remove",
    ),
    [
      { start: 0, end: 5 },
      { start: 10, end: 20 },
    ],
  );
  assert.deepEqual(
    changeWritingHighlight(
      [
        { start: 0, end: 5 },
        { start: 10, end: 20 },
      ],
      { start: 3, end: 15 },
      "remove",
    ),
    [
      { start: 0, end: 3 },
      { start: 15, end: 20 },
    ],
  );
  assert.deepEqual(
    changeWritingHighlight(
      [{ start: 0, end: 20 }],
      { start: 0, end: 20 },
      "remove",
    ),
    [],
  );
});

test("per-task highlights survive switching, essay editing, reload and submission without changing answers or the shared deadline", () => {
  const config = {
    paperId: "paper",
    runId: "run",
    itemIds: ["letter", "essay"],
    startedAt: 1_000_000,
  };
  let draft = restorePaperWriting(null, config);
  draft = {
    ...draft,
    promptHighlights: {
      letter: [{ start: 0, end: 5 }],
      essay: [{ start: 20, end: 30 }],
    },
  };
  draft = switchPaperWritingTask(draft, "essay");
  draft = editPaperWriting(
    draft,
    "essay",
    "text",
    "My response.",
    config.startedAt + 1000,
  );
  draft = editPaperWriting(
    draft,
    "letter",
    "notes",
    "Selected prompt excerpt",
    config.startedAt + 2000,
  );
  const restored = restorePaperWriting(
    JSON.parse(JSON.stringify(draft)),
    config,
  );
  assert.deepEqual(restored.promptHighlights, draft.promptHighlights);
  assert.deepEqual(restored.responses, {
    letter: { text: "", notes: "Selected prompt excerpt" },
    essay: { text: "My response.", notes: "" },
  });
  const finished = finishPaperWriting(
    restored,
    "time-expired",
    draft.deadlineAt,
  );
  assert.deepEqual(finished.promptHighlights, draft.promptHighlights);
  assert.deepEqual(finished.responses, draft.responses);
  assert.equal(finished.finishedAt, config.startedAt + 3_600_000);
  assert.equal(finished.deadlineAt, draft.deadlineAt);
  assert.equal(restorePaperWriting(null, config).promptHighlights, undefined);
});
