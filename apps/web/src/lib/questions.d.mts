export interface Choice {
  value: string;
  label: string;
  content: string;
}
export interface QuestionRow {
  id: string;
  number: number;
  endNumber: number;
  type: string;
  content: string;
  options: Choice[];
  expected: any;
  weight: number;
  slots: number;
  solution: any;
  supported: boolean;
}
export interface QuestionGroup {
  id: string;
  type: string;
  title: string;
  start: number;
  end: number;
  count: number;
  description: string;
  content: string;
  image: string;
  optionsImage: string;
  optionsTitle: string;
  rows: QuestionRow[];
  raw: any;
}
export interface GradeResult {
  id: string;
  number: number;
  status: string;
  earned: number;
  total: number;
  reason?: string;
}
export interface Grade {
  results: GradeResult[];
  score: number;
  total: number;
  manual: number;
}
export const QUESTION_TYPES: Record<string, string>;
export function normalizeAnswer(value: unknown): string;
export function optionLabel(
  option: any,
  index: number,
  indexType?: string,
): string;
export function buildGroups(input: any): QuestionGroup[];
export function assessRow(
  row: QuestionRow,
  answer: unknown,
): Omit<GradeResult, "id" | "number">;
export function gradeGroups(
  groups: QuestionGroup[],
  answers: Record<string, string | string[]>,
): Grade;
export function displayAnswer(row: QuestionRow, value?: any): string;
export function parseTranscript(
  value: unknown,
  totalSeconds?: number,
): { start: number; end: number; text: string; translation: string }[];
export function answerQuotes(solution: any): string[];
