export function writingClock(
  startedAt: number | null,
  deadlineAt: number | null,
  finishedAt: number | null,
  now?: number,
): {
  elapsedSeconds: number;
  remainingSeconds: number | null;
  expired: boolean;
};
export function writingLimit(value: unknown): 0 | 20 | 40;
export function writingDraftRevision(draft: unknown): string;
export function writingRevisionMatches(
  expected: string,
  currentDraft: unknown,
): boolean;
export function writingCanRecord(
  expected: string,
  currentDraft: unknown,
  runId: string,
): boolean;
