import type { QuestionGroup, Choice } from "./questions.mjs";
export function diagramMatchingMatrix(group: QuestionGroup): {
  options: Choice[];
  rows: { rowId: string; html: string }[];
} | null;
