export function writingClock(
  startedAt,
  deadlineAt,
  finishedAt,
  now = Date.now(),
) {
  const start = Number(startedAt);
  const deadline = Number(deadlineAt);
  const finished = Number(finishedAt);
  const hasDeadline =
    deadlineAt != null && Number.isFinite(deadline) && deadline > 0;
  const end =
    finishedAt != null && Number.isFinite(finished) && finished > 0
      ? finished
      : now;
  const effectiveEnd = hasDeadline ? Math.min(end, deadline) : end;
  return {
    elapsedSeconds:
      Number.isFinite(start) && start > 0
        ? Math.max(0, Math.floor((effectiveEnd - start) / 1000))
        : 0,
    remainingSeconds: hasDeadline
      ? Math.max(0, Math.ceil((deadline - end) / 1000))
      : null,
    expired: hasDeadline && end >= deadline,
  };
}

export function writingLimit(value) {
  return value === 20 || value === 40 ? value : 0;
}

export function writingDraftRevision(draft) {
  if (!draft || typeof draft !== "object") return "absent";
  return typeof draft.revision === "string" && draft.revision
    ? `${draft.revision}:${draft.runId || ""}:${draft.status || ""}`
    : `legacy:${JSON.stringify(draft)}`;
}

export function writingRevisionMatches(expected, currentDraft) {
  return expected === writingDraftRevision(currentDraft);
}

export function writingCanRecord(expected, currentDraft, runId) {
  return (
    !!runId &&
    writingRevisionMatches(expected, currentDraft) &&
    ["single-task-writing", "paper-writing"].includes(currentDraft?.mode) &&
    currentDraft.status === "finished" &&
    currentDraft.runId === runId
  );
}
