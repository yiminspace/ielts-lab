export const paperStages = ["listening", "reading", "writing"];
export const paperRunKey = (id) => `paper:${id}:run`;
export const paperFingerprint = (paper) =>
  JSON.stringify([paper.listeningIds, paper.readingIds, paper.writingIds]);

export function createPaperRun(paper, runId, now = Date.now()) {
  if (!paper.ready || !runId || !Number.isFinite(now) || now <= 0)
    throw new Error("This paper cannot be started.");
  return {
    version: 1,
    paperId: paper.id,
    fingerprint: paperFingerprint(paper),
    runId,
    phase: "listening",
    startedAt: now,
    stageStartedAt: now,
    results: {},
  };
}

export function restorePaperRun(raw, paper) {
  if (
    !raw ||
    raw.version !== 1 ||
    raw.paperId !== paper.id ||
    raw.fingerprint !== paperFingerprint(paper) ||
    typeof raw.runId !== "string" ||
    !raw.runId ||
    ![...paperStages, "complete"].includes(raw.phase) ||
    !Number.isFinite(raw.startedAt) ||
    raw.startedAt <= 0 ||
    !Number.isFinite(raw.stageStartedAt) ||
    raw.stageStartedAt < raw.startedAt ||
    !raw.results ||
    typeof raw.results !== "object"
  )
    return null;
  const completed =
    raw.phase === "complete" ? 3 : paperStages.indexOf(raw.phase);
  let previousEnd = raw.startedAt;
  for (let i = 0; i < 3; i++) {
    const result = raw.results[paperStages[i]];
    if (i >= completed) {
      if (result) return null;
      continue;
    }
    if (
      !validResult(result) ||
      result.startedAt !== previousEnd ||
      result.finishedAt < previousEnd
    )
      return null;
    previousEnd = result.finishedAt;
  }
  if (
    raw.stageStartedAt !== previousEnd ||
    (raw.phase === "complete" && raw.finishedAt !== previousEnd)
  )
    return null;
  return raw;
}

function validResult(result) {
  return (
    !!result &&
    Array.isArray(result.attemptIds) &&
    result.attemptIds.length > 0 &&
    result.attemptIds.every((id) => typeof id === "string" && id.length > 0) &&
    new Set(result.attemptIds).size === result.attemptIds.length &&
    ["submitted", "timeout"].includes(result.reason) &&
    Number.isFinite(result.finishedAt)
  );
}

export function advancePaperRun(run, runId, stage, result) {
  if (
    run.runId !== runId ||
    run.phase !== stage ||
    !paperStages.includes(stage)
  )
    return run;
  if (!validResult(result) || result.finishedAt < run.stageStartedAt)
    throw new Error("Invalid paper submission.");
  const phase = paperStages[paperStages.indexOf(stage) + 1] || "complete";
  return {
    ...run,
    phase,
    stageStartedAt: result.finishedAt,
    results: {
      ...run.results,
      [stage]: { ...result, startedAt: run.stageStartedAt },
    },
    ...(phase === "complete" ? { finishedAt: result.finishedAt } : {}),
  };
}

// Every part has a history record; shared section time must only count once.
export function totalPracticeSeconds(attempts) {
  const durations = new Map();
  for (const attempt of attempts) {
    const answers = attempt.answers || {};
    const run = answers.paperRunId;
    const key = run ? `${answers.paperId}:${run}:${attempt.kind}` : attempt.id;
    durations.set(
      key,
      Math.max(durations.get(key) || 0, Number(attempt.durationSeconds) || 0),
    );
  }
  return [...durations.values()].reduce((sum, value) => sum + value, 0);
}
