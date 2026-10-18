export type TestTrack = "academic" | "general" | "shared" | "unclassified";
export type Kind =
  | "listening"
  | "reading"
  | "writing"
  | "speaking"
  | "vocabulary"
  | "sentences"
  | "grammar"
  | "numbers"
  | "typing"
  | "courses";
export interface LibraryItem {
  id: string;
  title: string;
  kind: Kind;
  collection: string;
  count?: number;
  description?: string;
  testTrack?: TestTrack;
  source?: "archive" | "original";
}
export interface StudyItem extends LibraryItem {
  data: any;
  localMedia: Record<string, string>;
}
export interface Library {
  items: LibraryItem[];
  mode: "archive" | "demo";
  counts: Partial<Record<Kind, number>>;
  issues?: string[];
}
export interface Attempt {
  id: string;
  itemId: string;
  title: string;
  kind: Kind;
  createdAt: string;
  score?: number;
  total?: number;
  durationSeconds?: number;
  answers?: Record<string, string | string[]>;
  detail?: string;
}
export interface Progress {
  attempts: Attempt[];
  bookmarks: string[];
  drafts: Record<string, any>;
  notes: Record<string, string>;
  updatedAt?: string;
}

export interface ExamPaper {
  id: string;
  title: string;
  collection: string;
  testTrack: "general";
  source: "archive" | "original";
  listeningIds: string[];
  readingIds: string[];
  writingIds: string[];
  ready: boolean;
  issues: string[];
  shortDemo?: boolean;
  listeningMarks?: number;
  readingMarks?: number;
}
export interface ExamPaperDetail extends ExamPaper {
  listening: StudyItem[];
  reading: StudyItem[];
  writing: StudyItem[];
}
