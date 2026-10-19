import type { QuestionRow } from "./questions.mjs";

export function resolveSolutionLine(
  solution: unknown,
  lines: { text: string }[],
): number;
export function compactAnswer(row: QuestionRow): {
  primary: string;
  alternatives: string[];
};
export function completedBlankAnswer(row: QuestionRow): string | null;
