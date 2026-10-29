/** Summarize submitted records without relying on their storage order. */
export function practiceSummaries(attempts) {
  const summaries = new Map();
  for (const attempt of attempts) {
    const summary = summaries.get(attempt.itemId);
    if (!summary) {
      summaries.set(attempt.itemId, { count: 1, latest: attempt });
    } else {
      summary.count++;
      if (Date.parse(attempt.createdAt) > Date.parse(summary.latest.createdAt))
        summary.latest = attempt;
    }
  }
  return summaries;
}

export function latestPracticeResult(attempt) {
  const { score, total } = attempt;
  if (
    Number.isFinite(score) &&
    Number.isFinite(total) &&
    total > 0 &&
    score >= 0 &&
    score <= total
  )
    return `最近一次：答对 ${score}/${total} · 正确率 ${Math.round((score / total) * 100)}%`;
  return "最近一次：已完成";
}
