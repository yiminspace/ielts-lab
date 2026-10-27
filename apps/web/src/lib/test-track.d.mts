import type { LibraryItem, TestTrack } from "../types";

export function testTrackEvidence(
  item: Partial<LibraryItem>,
  metadata?: Record<string, unknown>,
): Exclude<TestTrack, "unclassified">[];
export function classifyTestTrack(
  item: Partial<LibraryItem>,
  metadata?: Record<string, unknown>,
): TestTrack;
export function matchesTestTrack(
  item: Partial<LibraryItem>,
  requested?: TestTrack | "all",
): boolean;
