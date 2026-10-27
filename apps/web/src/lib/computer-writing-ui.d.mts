export type WritingHighlight = { start: number; end: number };
export function writingSplit(value: unknown): number;
export function resizeWritingSplit(current: number, key: string): number;
export function writingHighlightRanges(value: unknown): WritingHighlight[];
export function changeWritingHighlight(
  existing: unknown,
  selected: WritingHighlight,
  action: "add" | "remove",
): WritingHighlight[];
