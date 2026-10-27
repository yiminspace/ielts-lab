import test from "node:test";
import assert from "node:assert/strict";
import {
  writingClock,
  writingLimit,
  writingDraftRevision,
  writingRevisionMatches,
  writingCanRecord,
} from "../apps/web/src/lib/computer-writing.mjs";

test("a writing deadline survives backgrounding and reload without extending the time", () => {
  const startedAt = 100000;
  const deadlineAt = startedAt + 20 * 60 * 1000;
  assert.equal(
    writingClock(startedAt, deadlineAt, null, startedAt + 12000)
      .remainingSeconds,
    1188,
  );
  const afterLongSleep = writingClock(
    startedAt,
    deadlineAt,
    null,
    deadlineAt + 90000,
  );
  assert.deepEqual(afterLongSleep, {
    elapsedSeconds: 1200,
    remainingSeconds: 0,
    expired: true,
  });
});

test("untimed familiarisation has no hidden deadline and finished elapsed time is stable", () => {
  assert.deepEqual(writingClock(100000, null, null, 115000), {
    elapsedSeconds: 15,
    remainingSeconds: null,
    expired: false,
  });
  assert.deepEqual(writingClock(100000, null, 112000, 130000), {
    elapsedSeconds: 12,
    remainingSeconds: null,
    expired: false,
  });
  assert.equal(writingClock(null, null, null, 130000).elapsedSeconds, 0);
});

test("only explicit supported time limits enable timed single-task practice", () => {
  assert.equal(writingLimit(20), 20);
  assert.equal(writingLimit(40), 40);
  for (const value of [0, 60, -1, "20", undefined, null])
    assert.equal(writingLimit(value), 0);
});

test("a stale writing tab cannot overwrite a newer revision or a newer session", () => {
  const original = {
    mode: "single-task-writing",
    revision: "r1",
    runId: "session-a",
    status: "running",
    text: "initial",
  };
  const lastSeen = writingDraftRevision(original);
  assert.ok(writingRevisionMatches(lastSeen, original));
  assert.equal(
    writingRevisionMatches(lastSeen, {
      ...original,
      revision: "r2",
      text: "newer answer",
    }),
    false,
  );
  assert.equal(
    writingRevisionMatches(lastSeen, { ...original, runId: "session-b" }),
    false,
  );
  assert.equal(writingRevisionMatches(lastSeen, undefined), false);
  assert.equal(writingRevisionMatches("absent", original), false);
});

test("finished-session recording requires the current draft revision and session", () => {
  const finished = {
    mode: "single-task-writing",
    revision: "finished-1",
    runId: "session-a",
    status: "finished",
  };
  const revision = writingDraftRevision(finished);
  assert.ok(writingCanRecord(revision, finished, "session-a"));
  assert.equal(
    writingCanRecord(
      revision,
      { ...finished, revision: "recorded-2" },
      "session-a",
    ),
    false,
  );
  assert.equal(writingCanRecord(revision, finished, "session-b"), false);
  assert.equal(
    writingCanRecord(revision, { ...finished, status: "running" }, "session-a"),
    false,
  );
});

test("legacy drafts without a revision still detect external text changes", () => {
  const legacy = {
    mode: "single-task-writing",
    runId: "old",
    status: "running",
    text: "old answer",
  };
  assert.equal(
    writingRevisionMatches(writingDraftRevision(legacy), {
      ...legacy,
      text: "new answer",
    }),
    false,
  );
});
