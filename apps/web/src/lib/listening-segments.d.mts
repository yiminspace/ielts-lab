import type {
  QuestionGroup,
  QuestionRow,
  parseTranscript,
} from "./questions.mjs";
export interface ListeningSegment {
  position: number;
  start: number;
  end: number | null;
  entries: { row: QuestionRow; group: QuestionGroup; index: number }[];
  lines: ReturnType<typeof parseTranscript>;
}
export function listeningSegments(
  data: any,
  duration?: number,
): {
  segments: ListeningSegment[];
  error: string;
};
export function missedSegmentPositions(
  segments: ListeningSegment[],
  answers: Record<string, string | string[]> | undefined,
): Set<number>;
