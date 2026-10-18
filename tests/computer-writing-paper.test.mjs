import test from "node:test";
import assert from "node:assert/strict";
import {
  PAPER_WRITING_DURATION,
  restorePaperWriting,
  startPaperWriting,
  switchPaperWritingTask,
  editPaperWriting,
  finishPaperWriting,
  paperWritingAttempt,
  paperWritingCompletion,
} from "../src/lib/computer-writing-paper.mjs";
import {
  writingClock,
  writingCanRecord,
  writingDraftRevision,
} from "../src/lib/computer-writing.mjs";

const config = {
  paperId: "general-paper",
  runId: "run-1",
  itemIds: ["letter", "essay"],
  startedAt: 1_000_000,
};

test("paper writing starts from the orchestrator timestamp and every switch shares the same sixty-minute deadline", () => {
  const initial = restorePaperWriting(null, config);
  assert.equal(initial.status, "running");
  assert.equal(PAPER_WRITING_DURATION, 3_600_000);
  const switched = switchPaperWritingTask(initial, "essay");
  assert.equal(switched.activeItemId, "essay");
  assert.equal(switched.startedAt, config.startedAt);
  assert.equal(switched.deadlineAt, config.startedAt + 3_600_000);
  assert.equal(startPaperWriting(switched), switched);
  assert.equal(
    writingClock(
      switched.startedAt,
      switched.deadlineAt,
      null,
      config.startedAt + 600_000,
    ).remainingSeconds,
    3000,
  );
  const delayedStart = restorePaperWriting(null, {
    ...config,
    autoStart: false,
  });
  assert.equal(delayedStart.status, "ready");
  assert.equal(startPaperWriting(delayedStart).deadlineAt, initial.deadlineAt);
});

test("both essays and both notes survive task switches and reload, which cannot extend the deadline", () => {
  let draft = restorePaperWriting(null, config);
  draft = editPaperWriting(
    draft,
    "letter",
    "text",
    "Dear manager,",
    config.startedAt + 1000,
  );
  draft = editPaperWriting(
    draft,
    "letter",
    "notes",
    "Explain the booking",
    config.startedAt + 2000,
  );
  draft = switchPaperWritingTask(draft, "essay");
  draft = editPaperWriting(
    draft,
    "essay",
    "text",
    "Local projects can benefit residents.",
    config.startedAt + 3000,
  );
  draft = editPaperWriting(
    draft,
    "essay",
    "notes",
    "Discuss both views",
    config.startedAt + 4000,
  );
  const restored = restorePaperWriting(
    JSON.parse(
      JSON.stringify({ ...draft, deadlineAt: draft.deadlineAt + 999_999 }),
    ),
    config,
  );
  assert.deepEqual(restored.responses, draft.responses);
  assert.equal(restored.activeItemId, "essay");
  assert.equal(restored.deadlineAt, config.startedAt + PAPER_WRITING_DURATION);
  const back = switchPaperWritingTask(restored, "letter");
  assert.equal(back.responses.letter.text, "Dear manager,");
  assert.equal(back.responses.essay.notes, "Discuss both views");
  assert.equal(switchPaperWritingTask(back, "unknown"), back);
});

test("expiry blocks editing both tasks immediately and completes at the original deadline", () => {
  const draft = restorePaperWriting(null, config);
  for (const id of config.itemIds) {
    assert.equal(
      editPaperWriting(draft, id, "text", "Too late", draft.deadlineAt),
      draft,
    );
    assert.equal(
      editPaperWriting(draft, id, "notes", "Too late", draft.deadlineAt + 1),
      draft,
    );
  }
  const completed = finishPaperWriting(
    draft,
    "manual",
    draft.deadlineAt + 500_000,
  );
  assert.equal(completed.status, "finished");
  assert.equal(completed.finishReason, "time-expired");
  assert.equal(completed.finishedAt, draft.deadlineAt);
  assert.equal(
    finishPaperWriting(completed, "manual", draft.deadlineAt + 900_000),
    completed,
  );
  assert.equal(
    editPaperWriting(
      completed,
      "letter",
      "text",
      "Changed",
      config.startedAt + 1,
    ),
    completed,
  );
  assert.ok(
    writingCanRecord(writingDraftRevision(completed), completed, config.runId),
  );
});

test("manual submission preserves both responses and reports the actual shared completion time", () => {
  let draft = restorePaperWriting(null, config);
  draft = editPaperWriting(
    draft,
    "essay",
    "text",
    "An unfinished essay",
    config.startedAt + 1000,
  );
  const completed = finishPaperWriting(
    draft,
    "manual",
    config.startedAt + 50_000,
  );
  assert.equal(completed.finishedAt, config.startedAt + 50_000);
  assert.equal(completed.finishReason, "manual");
  assert.deepEqual(completed.responses, draft.responses);
  assert.equal(
    paperWritingCompletion(completed),
    null,
    "History must be durable before advancing the paper",
  );
  const recorded = {
    ...completed,
    attemptRecorded: true,
    attemptIds: ["letter-record", "essay-record"],
  };
  const result = {
    attemptIds: ["letter-record", "essay-record"],
    finishedAt: config.startedAt + 50_000,
    reason: "submitted",
  };
  assert.deepEqual(paperWritingCompletion(recorded), result);
  assert.deepEqual(
    paperWritingCompletion(
      restorePaperWriting(JSON.parse(JSON.stringify(recorded)), config),
    ),
    result,
  );
  assert.equal(
    paperWritingCompletion({ ...recorded, attemptIds: ["same", "same"] }),
    null,
  );
});

test("reload and retry find only the matching paper run's existing history, allowing at-most-once records", () => {
  const draft = finishPaperWriting(
    restorePaperWriting(null, config),
    "time-expired",
    config.startedAt + PAPER_WRITING_DURATION,
  );
  const attempts = [
    {
      id: "wrong-paper",
      itemId: "letter",
      answers: {
        paperId: "other",
        paperRunId: config.runId,
        writingSession: `other:${config.runId}:writing`,
      },
    },
    {
      id: "old-run",
      itemId: "letter",
      answers: {
        paperId: config.paperId,
        paperRunId: "run-0",
        writingSession: `${config.paperId}:run-0:writing`,
      },
    },
  ];
  let writes = 0;
  const recover = () =>
    config.itemIds.map((itemId) => {
      let existing = paperWritingAttempt(draft, itemId, attempts);
      if (!existing) {
        writes++;
        attempts.push({
          id: `record-${itemId}`,
          itemId,
          answers: {
            paperId: config.paperId,
            paperRunId: config.runId,
            writingSession: `${config.paperId}:${config.runId}:writing`,
          },
        });
        existing = paperWritingAttempt(draft, itemId, attempts);
      }
      return existing.id;
    });
  const ids = recover();
  assert.deepEqual(recover(), ids);
  assert.equal(writes, 2);
  assert.deepEqual(
    paperWritingCompletion({
      ...draft,
      attemptRecorded: true,
      attemptIds: ids,
    }),
    { attemptIds: ids, finishedAt: draft.deadlineAt, reason: "timeout" },
  );
});

test("a new paper run cannot restore the previous run's answers or completion", () => {
  const old = editPaperWriting(
    restorePaperWriting(null, config),
    "letter",
    "text",
    "Old letter",
    config.startedAt + 1,
  );
  const fresh = restorePaperWriting(old, {
    ...config,
    runId: "run-2",
    startedAt: 2_000_000,
  });
  assert.equal(fresh.responses.letter.text, "");
  assert.equal(fresh.runId, "run-2");
  assert.equal(fresh.attemptRecorded, false);
  assert.equal(fresh.deadlineAt, 5_600_000);
});
