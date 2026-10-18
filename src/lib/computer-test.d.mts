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

export interface PaperPart {
  itemId: string;
  partIndex: number;
  prefix: string;
  originalGroups: QuestionGroup[];
  groups: QuestionGroup[];
  first: number;
  last: number;
}
export function paperParts(items: import("../types").StudyItem[]): PaperPart[];
export function answersForPart(
  part: PaperPart,
  answers: Record<string, string | string[]>,
): Record<string, string | string[]>;
export function paperDraftKey(
  paperId: string,
  runId: string,
  kind: string,
): string;
export function paperReadingDeadline(startedAt: number): number;
export function advancePaperAudio(
  state: { audioIndex?: number; audioEnded: boolean; deadline: number | null },
  eventIndex: number,
  count: number,
  now: number,
  successful?: boolean,
): {
  audioIndex: number;
  audioPosition: number;
  audioEnded: boolean;
  deadline: number | null;
} | null;
export function validatePaperParts(
  items: import("../types").StudyItem[],
  parts: PaperPart[],
  kind: string,
  shortDemo?: boolean,
): string;

export function renumberGapPrefixes(
  html: string,
  originalRows: QuestionRow[],
  normalizedRows: QuestionRow[],
): string;

export function navigationDestination(
  numbers: number[],
  current: number,
  key: string,
): number | null;
export function splitByKeyboard(current: number, key: string): number | null;
