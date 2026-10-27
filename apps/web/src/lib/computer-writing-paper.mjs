export const PAPER_WRITING_DURATION = 60 * 60 * 1000;

export function restorePaperWriting(saved, config) {
  const { paperId, runId, itemIds, startedAt, autoStart = true } = config;
  const fresh = {
    version: 1,
    mode: "paper-writing",
    status: autoStart ? "running" : "ready",
    paperId,
    runId,
    taskIds: [...itemIds],
    activeItemId: itemIds[0],
    responses: Object.fromEntries(
      itemIds.map((id) => [id, { text: "", notes: "" }]),
    ),
    text: "",
    notes: "",
    limitMinutes: 60,
    startedAt,
    deadlineAt: startedAt + PAPER_WRITING_DURATION,
    finishedAt: null,
    finishReason: null,
    attemptRecorded: false,
    attemptIds: [],
  };
  if (
    !saved ||
    saved.mode !== "paper-writing" ||
    saved.paperId !== paperId ||
    saved.runId !== runId ||
    !["ready", "running", "finished"].includes(saved.status) ||
    JSON.stringify(saved.taskIds) !== JSON.stringify(itemIds)
  )
    return fresh;
  return {
    ...fresh,
    ...saved,
    startedAt,
    deadlineAt: startedAt + PAPER_WRITING_DURATION,
    activeItemId: itemIds.includes(saved.activeItemId)
      ? saved.activeItemId
      : itemIds[0],
    responses: Object.fromEntries(
      itemIds.map((id) => [
        id,
        {
          text:
            typeof saved.responses?.[id]?.text === "string"
              ? saved.responses[id].text
              : "",
          notes:
            typeof saved.responses?.[id]?.notes === "string"
              ? saved.responses[id].notes
              : "",
        },
      ]),
    ),
    attemptIds: Array.isArray(saved.attemptIds)
      ? saved.attemptIds.filter((id) => typeof id === "string")
      : [],
    status: autoStart && saved.status === "ready" ? "running" : saved.status,
  };
}

export function startPaperWriting(draft) {
  return draft.status === "ready" ? { ...draft, status: "running" } : draft;
}

export function switchPaperWritingTask(draft, itemId) {
  return draft.taskIds.includes(itemId)
    ? { ...draft, activeItemId: itemId }
    : draft;
}

export function editPaperWriting(
  draft,
  itemId,
  field,
  value,
  now = Date.now(),
) {
  if (
    draft.status !== "running" ||
    now >= draft.deadlineAt ||
    !draft.taskIds.includes(itemId) ||
    !["text", "notes"].includes(field)
  )
    return draft;
  return {
    ...draft,
    responses: {
      ...draft.responses,
      [itemId]: { ...draft.responses[itemId], [field]: value },
    },
  };
}

export function finishPaperWriting(draft, reason, now = Date.now()) {
  if (draft.status !== "running") return draft;
  const expired = now >= draft.deadlineAt || reason === "time-expired";
  return {
    ...draft,
    status: "finished",
    finishedAt: expired ? draft.deadlineAt : now,
    finishReason: expired ? "time-expired" : "manual",
  };
}

export function paperWritingAttempt(draft, itemId, attempts) {
  return attempts.find(
    (attempt) =>
      attempt.itemId === itemId &&
      attempt.answers?.paperId === draft.paperId &&
      attempt.answers?.paperRunId === draft.runId &&
      attempt.answers?.writingSession ===
        `${draft.paperId}:${draft.runId}:writing`,
  );
}

export function paperWritingCompletion(draft) {
  if (
    draft.status !== "finished" ||
    !draft.attemptRecorded ||
    !Number.isFinite(draft.finishedAt) ||
    !Array.isArray(draft.attemptIds) ||
    draft.attemptIds.length !== 2 ||
    new Set(draft.attemptIds).size !== 2
  )
    return null;
  return {
    attemptIds: [...draft.attemptIds],
    finishedAt: draft.finishedAt,
    reason: draft.finishReason === "time-expired" ? "timeout" : "submitted",
  };
}
