import type { Attempt } from "../types";
export interface PaperWritingConfig {
  paperId: string;
  runId: string;
  itemIds: string[];
  startedAt: number;
  autoStart?: boolean;
}
export interface PaperWritingDraft {
  version: 1;
  mode: "paper-writing";
  status: "ready" | "running" | "finished";
  paperId: string;
  runId: string;
  taskIds: string[];
  activeItemId: string;
  responses: Record<string, { text: string; notes: string }>;
  text: string;
  notes: string;
  limitMinutes: 60;
  startedAt: number;
  deadlineAt: number;
  finishedAt: number | null;
  finishReason: "manual" | "time-expired" | null;
  attemptRecorded: boolean;
  attemptIds: string[];
  revision?: string;
}
export interface PaperWritingResult {
  attemptIds: string[];
  finishedAt: number;
  reason: "submitted" | "timeout";
}
export const PAPER_WRITING_DURATION: number;
export function restorePaperWriting(
  saved: unknown,
  config: PaperWritingConfig,
): PaperWritingDraft;
export function startPaperWriting(draft: PaperWritingDraft): PaperWritingDraft;
export function switchPaperWritingTask(
  draft: PaperWritingDraft,
  itemId: string,
): PaperWritingDraft;
export function editPaperWriting(
  draft: PaperWritingDraft,
  itemId: string,
  field: "text" | "notes",
  value: string,
  now?: number,
): PaperWritingDraft;
export function finishPaperWriting(
  draft: PaperWritingDraft,
  reason: "manual" | "time-expired",
  now?: number,
): PaperWritingDraft;
export function paperWritingAttempt(
  draft: PaperWritingDraft,
  itemId: string,
  attempts: Attempt[],
): Attempt | undefined;
export function paperWritingCompletion(
  draft: PaperWritingDraft,
): PaperWritingResult | null;
