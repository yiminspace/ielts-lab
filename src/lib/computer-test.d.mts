import type { QuestionGroup, QuestionRow, Choice } from "./questions.mjs";
export interface QuestionNav {
  number: number;
  rowId: string;
  groupId: string;
  offset: number;
}
export function remainingSeconds(
  deadline: number | null | undefined,
  now?: number,
): number | null;
export function elapsedSeconds(
  startedAt: number,
  now?: number,
  deadline?: number | null,
): number;
export function questionNavigation(groups: QuestionGroup[]): QuestionNav[];
export function answeredQuestion(
  nav: QuestionNav,
  row: QuestionRow,
  answers: Record<string, string | string[]>,
): boolean;
export function optionFromDrop(
  payload: string,
  groupId: string,
  options: Choice[],
): string | null;
export function examDraftKey(itemId: string): string;
export function validSession(value: any): boolean;
export function sessionSignature(value: unknown): string;
export function prepareSessionSave<T extends Record<string, unknown>>(
  current: unknown,
  expectedSignature: string,
  proposed: T,
): (T & { revision: number }) | null;
