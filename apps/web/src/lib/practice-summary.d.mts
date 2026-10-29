import type { Attempt } from "../types";

export function practiceSummaries(
  attempts: Attempt[],
): Map<string, { count: number; latest: Attempt }>;
export function latestPracticeResult(attempt: Attempt): string;
