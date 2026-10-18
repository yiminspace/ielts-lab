import test from "node:test";
import assert from "node:assert/strict";
import {
  createPaperRun,
  restorePaperRun,
  advancePaperRun,
  totalPracticeSeconds,
} from "../src/lib/paper-session.mjs";
const paper = {
  id: "p",
  ready: true,
  listeningIds: ["l"],
  readingIds: ["r"],
  writingIds: ["w1", "w2"],
};
const result = (at, id, reason = "submitted") => ({
  finishedAt: at,
  attemptIds: [id],
  reason,
});
test("full paper advances once through all sections and retains absolute deadlines", () => {
  let run = createPaperRun(paper, "run", 1000);
  const reading = advancePaperRun(run, "run", "listening", result(10000, "l"));
  assert.equal(reading.phase, "reading");
  assert.equal(reading.stageStartedAt, 10000);
  assert.equal(
    advancePaperRun(reading, "run", "listening", result(20000, "duplicate")),
    reading,
  );
  run = advancePaperRun(
    reading,
    "run",
    "reading",
    result(3610000, "r", "timeout"),
  );
  assert.equal(run.phase, "writing");
  assert.equal(run.stageStartedAt + 3600000, 7210000);
  run = advancePaperRun(run, "run", "writing", result(7210000, "w", "timeout"));
  assert.equal(run.phase, "complete");
  assert.equal(run.finishedAt, 7210000);
  assert.deepEqual(
    restorePaperRun(JSON.parse(JSON.stringify(run)), paper),
    run,
  );
});
test("resume rejects mismatched materials and incomplete transition checkpoints", () => {
  const run = createPaperRun(paper, "run", 1000);
  assert.equal(restorePaperRun(run, { ...paper, writingIds: ["other"] }), null);
  assert.equal(restorePaperRun({ ...run, phase: "writing" }, paper), null);
  assert.equal(restorePaperRun({ ...run, stageStartedAt: 0 }, paper), null);
  assert.equal(
    advancePaperRun(run, "old-run", "listening", result(2000, "a")),
    run,
  );
});
test("invalid completion cannot move backwards or silently skip history", () => {
  const run = createPaperRun(paper, "run", 1000);
  assert.throws(() =>
    advancePaperRun(run, "run", "listening", result(999, "a")),
  );
  assert.throws(() =>
    advancePaperRun(run, "run", "listening", {
      ...result(2000, "a"),
      attemptIds: [],
    }),
  );
  assert.throws(() => createPaperRun({ ...paper, ready: false }, "r", 1000));
});
test("study duration counts shared section time once but keeps independent attempts", () => {
  assert.equal(
    totalPracticeSeconds([
      {
        id: "a",
        kind: "writing",
        durationSeconds: 600,
        answers: { paperId: "p", paperRunId: "r" },
      },
      {
        id: "b",
        kind: "writing",
        durationSeconds: 600,
        answers: { paperId: "p", paperRunId: "r" },
      },
      {
        id: "c",
        kind: "reading",
        durationSeconds: 200,
        answers: { paperId: "p", paperRunId: "r" },
      },
      { id: "d", kind: "writing", durationSeconds: 100, answers: {} },
    ]),
    900,
  );
});
