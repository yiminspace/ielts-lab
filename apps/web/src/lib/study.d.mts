export function countWords(value?: string): number;
export function normalizeDictation(value?: string, kind?: string): string;
export function checkDictation(
  input: string,
  expected: string,
  kind?: string,
): boolean;
export function typingMetrics(
  input: string,
  target: string,
  elapsedSeconds: number,
): {
  correct: number;
  accuracy: number;
  wpm: number;
  progress: number;
  complete: boolean;
};
export function formatTime(seconds?: number): string;
export function writingReview(
  itemId: string,
  attempt: unknown,
): {
  text: string;
  notes: string;
  words: number;
  durationSeconds: number | null;
  sharedTiming: boolean;
} | null;
export function reviewIndex(
  rows: Record<string, any>[],
  attempt: { answers?: Record<string, unknown>; detail?: string } | undefined,
  kind: string,
  fallback?: number,
): number;
