import type { Attempt, ExamPaper } from "../types";
export type PaperStage = "listening" | "reading" | "writing";
export interface PaperResult {
  attemptIds: string[];
  finishedAt: number;
  reason: "submitted" | "timeout";
}
export interface PaperRun {
  version: 1;
  paperId: string;
  fingerprint: string;
  runId: string;
  phase: PaperStage | "complete";
  startedAt: number;
  stageStartedAt: number;
  results: Partial<Record<PaperStage, PaperResult & { startedAt: number }>>;
  finishedAt?: number;
}
export const paperStages: PaperStage[];
export function paperRunKey(id: string): string;
export function paperFingerprint(paper: ExamPaper): string;
export function createPaperRun(
  paper: ExamPaper,
  runId: string,
  now?: number,
): PaperRun;
export function restorePaperRun(
  raw: unknown,
  paper: ExamPaper,
): PaperRun | null;
export function advancePaperRun(
  run: PaperRun,
  runId: string,
  stage: PaperStage,
  result: PaperResult,
): PaperRun;
export function totalPracticeSeconds(attempts: Attempt[]): number;
