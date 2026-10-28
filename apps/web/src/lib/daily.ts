export type DailyStatus =
  "pending" | "generating" | "ready" | "blocked" | "failed";
export type WritingLevel = "basic" | "extension" | "challenge";
export interface DailyCapabilities {
  runtime: boolean;
  asr: boolean;
  tts: boolean;
}
export interface DailyQuestion {
  id: string;
  kind: "choice" | "true_false" | "gap";
  prompt: string;
  options: string[];
  max_words: number;
  answer?: string;
  evidence?: string;
  explanation?: string;
}
export interface DailyMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  recordingId?: string;
  feedback?:
    string | { reply_en?: string; follow_up?: string; feedback_zh?: string };
  followUp?: string;
  outcome?: string;
  audioUrl?: string;
  voiceUrl?: string;
  status?: string;
  error?: string;
  excluded?: boolean;
  recognitionError?: boolean;
}
export interface DailyLesson {
  id: string;
  attemptId: string;
  version: number;
  status: DailyStatus;
  source: {
    itemId: string;
    title: string;
    part: number;
    paperId?: string;
    paperRunId?: string;
  };
  content?: {
    title: string;
    reading: {
      passage: string;
      translation: string;
      questions: DailyQuestion[];
    };
    conversation: {
      topic: string;
      opening: string;
      opening_zh: string;
      starters: string[];
    };
    writing: {
      tasks: {
        level: WritingLevel;
        instruction: string;
        goal: string;
        hints: string[];
      }[];
    };
  };
  reading: {
    draft?: { answers?: Record<string, string> };
    attempts: {
      id: string;
      answers: Record<string, string>;
      score: number;
      total: number;
      results: {
        id: string;
        correct: boolean;
        userAnswer: string;
        answer: string;
        evidence: string;
        explanation: string;
      }[];
      createdAt: string;
    }[];
  };
  conversation: {
    draft?: { text?: string };
    messages: DailyMessage[];
    completedAt?: string;
    status?: "active" | "finished";
  };
  writing: {
    draft?: { text?: string; level?: WritingLevel };
    submissions: {
      id: string;
      text: string;
      level: WritingLevel;
      createdAt: string;
      status?: string;
      action?: string;
      feedback?: {
        feedback_zh: string;
        corrections: {
          original: string;
          corrected: string;
          reason_zh: string;
        }[];
        suggestion_en: string;
        task_complete: boolean;
        follow_up_zh: string;
      };
    }[];
    discussion?: {
      id: string;
      question: string;
      answer: string;
      createdAt: string;
    }[];
  };
  expressionHelp?: { english?: string; clarification_zh?: string };
  pending?: { kind: string; requestId: string; state: string } | null;
  error?: string | { message?: string; code?: string } | null;
  capabilities?: DailyCapabilities;
  recordings?: {
    id: string;
    audioUrl: string;
    status: string;
    text?: string;
    durationSeconds: number;
    createdAt: string;
  }[];
  createdAt: string;
  updatedAt: string;
}
export const dailyStatusText: Record<DailyStatus, string> = {
  pending: "等待生成",
  generating: "正在生成练习",
  ready: "可以开始练习",
  blocked: "AI 服务尚未配置",
  failed: "练习生成失败",
};
export const dailyErrorText = (error: DailyLesson["error"]) =>
  typeof error === "string" ? error : error?.message || "";
export class DailyRequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
async function responseJSON(response: Response) {
  const value = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new DailyRequestError(
      value.error || `服务暂不可用（${response.status}）`,
      response.status,
    );
  return value;
}
export async function listDaily(
  signal?: AbortSignal,
): Promise<{ lessons: DailyLesson[]; capabilities: DailyCapabilities }> {
  return responseJSON(await fetch("/api/daily", { signal }));
}
export async function getDaily(
  id: string,
  signal?: AbortSignal,
): Promise<DailyLesson> {
  return responseJSON(
    await fetch(`/api/daily/${encodeURIComponent(id)}`, { signal }),
  );
}
export async function actDaily(
  id: string,
  action: string,
  body: Record<string, unknown>,
): Promise<DailyLesson> {
  return responseJSON(
    await fetch(`/api/daily/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}
export async function recordDaily(
  id: string,
  blob: Blob,
  body: { requestId: string; expectedVersion: number; durationSeconds: number },
): Promise<DailyLesson> {
  return responseJSON(
    await fetch(
      `/api/daily/${encodeURIComponent(id)}/recordings?${new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)]))}`,
      {
        method: "POST",
        headers: { "Content-Type": blob.type || "audio/webm" },
        body: blob,
      },
    ),
  );
}
