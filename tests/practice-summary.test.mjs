import test from "node:test";
import assert from "node:assert/strict";
import {
  practiceSummaries,
  latestPracticeResult,
} from "../apps/web/src/lib/practice-summary.mjs";

test("catalog counts each item's submissions and selects latest by time, not score or array order", () => {
  const latest = {
    itemId: "listening",
    createdAt: "2026-10-29T02:00:00Z",
    score: 0,
    total: 10,
  };
  const records = [
    { ...latest, createdAt: "2026-10-28T02:00:00Z", score: 10 },
    latest,
    { itemId: "writing", createdAt: "2026-10-29T01:00:00Z" },
    { ...latest, createdAt: "2026-10-29T01:00:00Z", score: 7 },
  ];
  const summaries = practiceSummaries(records);
  assert.deepEqual(summaries.get("listening"), { count: 3, latest });
  assert.equal(summaries.get("writing").count, 1);
  assert.equal(summaries.has("new"), false);
  assert.equal(latestPracticeResult(latest), "最近一次：答对 0/10 · 正确率 0%");
});

test("catalog reports a rounded correct rate only for valid scored submissions", () => {
  assert.equal(
    latestPracticeResult({ score: 2, total: 3 }),
    "最近一次：答对 2/3 · 正确率 67%",
  );
  for (const attempt of [
    {},
    { score: 0, total: 0 },
    { score: 1 },
    { total: 4 },
    { score: -1, total: 4 },
    { score: 5, total: 4 },
  ])
    assert.equal(latestPracticeResult(attempt), "最近一次：已完成");
});
