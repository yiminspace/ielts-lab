import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  BookOpen,
  Check,
  ChevronRight,
  MessageCircle,
  Mic,
  PenLine,
  Play,
  RotateCcw,
  Square,
} from "lucide-react";
import {
  actDaily,
  dailyErrorText,
  dailyStatusText,
  DailyRequestError,
  getDaily,
  listDaily,
  recordDaily,
  type DailyCapabilities,
  type DailyLesson,
  type DailyMessage,
  type WritingLevel,
} from "../lib/daily";
import { useRuntime } from "../lib/runtime";
import {
  listPendingRecordings,
  removePendingRecording,
  stashRecording,
  type PendingRecording,
} from "../lib/recordings";
import "../daily.css";
import DailyPassage from "./DailyPassage";

const noCapabilities: DailyCapabilities = {
  runtime: false,
  asr: false,
  tts: false,
};
const levelNames: Record<WritingLevel, string> = {
  basic: "基础",
  extension: "延伸",
  challenge: "挑战",
};
const partDescriptions = [
  "熟悉的生活话题，先表达一个清楚的意思。",
  "说明经历和安排，再补充原因与细节。",
  "比较想法，解释选择，回应不同观点。",
  "讨论抽象主题，用理由和例子展开观点。",
];
const dateLabel = (value: string) =>
  new Date(value).toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
  });
const messageText = (message: DailyMessage) =>
  message.text ||
  (typeof message.feedback === "object" ? message.feedback.reply_en : "") ||
  "";
const feedbackText = (message: DailyMessage) =>
  typeof message.feedback === "string"
    ? message.feedback
    : message.feedback?.feedback_zh || "";

/** A listening result only observes its saved attempt. Generating never changes the exam route. */
export function DailyAttemptBanner({
  itemId,
  attemptId,
}: {
  itemId: string;
  attemptId?: string;
}) {
  const [lesson, setLesson] = useState<DailyLesson | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const value = await listDaily();
        if (!alive) return;
        const found = value.lessons.find(
          (entry) =>
            entry.source.itemId === itemId &&
            (!attemptId || entry.attemptId === attemptId),
        );
        setLesson(found || null);
        setLoaded(true);
        if (
          !found ||
          ["pending", "generating"].includes(found.status) ||
          found.pending
        )
          timer = setTimeout(load, 1800);
      } catch {
        if (alive) setLoaded(true);
      }
    }
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [itemId, attemptId]);
  return (
    <aside className="daily-result-entry" aria-label="听后练习">
      <div>
        <strong>把刚听过的，接着读、聊、写。</strong>
        <p role="status">
          {lesson
            ? dailyStatusText[lesson.status]
            : loaded
              ? "在听后练习中查看生成状态。"
              : "正在查看听后练习…"}
        </p>
      </div>
      <a
        className="button secondary"
        href={lesson ? `#/daily/${encodeURIComponent(lesson.id)}` : "#/daily"}
      >
        {lesson?.status === "ready" ? "打开听后练习" : "查看听后练习"}
        <ChevronRight size={16} />
      </a>
    </aside>
  );
}

export default function DailyWorkspace({ id }: { id?: string }) {
  const { userId } = useRuntime();
  const retryKey = `ielts-daily:${userId || "local"}:${id || "list"}:request`;
  const [lessons, setLessons] = useState<DailyLesson[]>([]);
  const [lesson, setLesson] = useState<DailyLesson | null>(null);
  const [capabilities, setCapabilities] = useState(noCapabilities);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [tab, setTab] = useState<"reading" | "conversation" | "writing">(
    "conversation",
  );
  const current = useRef<DailyLesson | null>(null);
  const alive = useRef(true);
  const lock = useRef(false);
  const activeWrite = useRef<Promise<void>>(Promise.resolve());
  const retry = useRef<{
    action: string;
    body: Record<string, unknown>;
    id: string;
  } | null>(null);
  const [hasRetry, setHasRetry] = useState(false);
  const [confirmedConversation, setConfirmedConversation] = useState("");
  const accept = useCallback((next: DailyLesson) => {
    if (
      !alive.current ||
      (current.current?.id === next.id &&
        current.current.version > next.version)
    )
      return;
    current.current = next;
    setLesson(next);
    if (next.capabilities) setCapabilities(next.capabilities);
  }, []);
  const reload = useCallback(async () => {
    if (id) accept(await getDaily(id));
    else {
      const value = await listDaily();
      if (alive.current) {
        setLessons(value.lessons);
        setCapabilities(value.capabilities);
      }
    }
  }, [id, accept]);
  useEffect(() => {
    alive.current = true;
    current.current = null;
    setLesson(null);
    setLoading(true);
    setError("");
    setHasRetry(false);
    retry.current = null;
    try {
      const saved = JSON.parse(localStorage.getItem(retryKey) || "null");
      if (
        saved &&
        typeof saved.action === "string" &&
        typeof saved.id === "string" &&
        saved.body &&
        typeof saved.body === "object"
      ) {
        retry.current = saved;
        setHasRetry(true);
        setError(
          "上次操作尚未收到确认。可以重试同一个请求，已保存的作答不会重复记入。",
        );
      }
    } catch {
      /* A damaged local request never replaces the server lesson. */
    }
    let active = true;
    void Promise.all([listDaily(), id ? getDaily(id) : Promise.resolve(null)])
      .then(([value, detail]) => {
        if (!active) return;
        setLessons(value.lessons);
        setCapabilities(value.capabilities);
        if (detail) accept(detail);
      })
      .catch((error) => {
        if (active) setError(error.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      alive.current = false;
    };
  }, [id, accept, retryKey]);
  const polling = id
    ? !!lesson?.pending ||
      ["pending", "generating"].includes(lesson?.status || "")
    : lessons.some(
        (entry) =>
          entry.pending || ["pending", "generating"].includes(entry.status),
      );
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => {
      void reload().catch(() => {
        if (alive.current)
          setError("暂时无法更新生成状态。练习已保存，可以重新载入。");
      });
    }, 1500);
    return () => clearInterval(timer);
  }, [polling, reload]);
  const send = useCallback(
    async (
      action: string,
      body: Record<string, unknown>,
      reuse = false,
    ): Promise<boolean> => {
      const quiet = action === "draft";
      if (lock.current && !quiet) await activeWrite.current;
      if (
        !alive.current ||
        !current.current ||
        lock.current ||
        (quiet && (retry.current || current.current.pending))
      )
        return false;
      lock.current = true;
      let releaseWrite!: () => void;
      activeWrite.current = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      if (!quiet) {
        setBusy(action);
        setError("");
      }
      const pending =
        reuse && retry.current
          ? retry.current
          : { action, body, id: crypto.randomUUID() };
      if (!quiet) {
        retry.current = pending;
        setHasRetry(false);
        try {
          localStorage.setItem(retryKey, JSON.stringify(pending));
        } catch {
          /* Keep the same request ID in memory. */
        }
      }
      try {
        accept(
          await actDaily(current.current.id, pending.action, {
            ...pending.body,
            expectedVersion: current.current.version,
            requestId: pending.id,
          }),
        );
        if (!quiet) {
          retry.current = null;
          try {
            localStorage.removeItem(retryKey);
          } catch {
            /* Replaying an acknowledged request remains idempotent. */
          }
          if (pending.action === "conversation")
            setConfirmedConversation(pending.id);
        }
        return true;
      } catch (error) {
        if (error instanceof DailyRequestError && error.status === 409) {
          await reload().catch(() => {});
          if (!quiet)
            setError(
              "进度已在另一处更新，已重新载入。你的草稿仍保留，请确认后重试。",
            );
        } else if (!quiet)
          setError(
            error instanceof Error ? error.message : "保存失败，请重试。",
          );
        if (!quiet) setHasRetry(true);
        return false;
      } finally {
        lock.current = false;
        releaseWrite();
        if (alive.current) setBusy("");
      }
    },
    [accept, reload, retryKey],
  );
  const acceptRecording = useCallback(
    async (recording: PendingRecording) => {
      if (!current.current || lock.current)
        throw new Error("正在保存其他内容，请稍后重试上传。");
      lock.current = true;
      setBusy("recordings");
      try {
        const next = await recordDaily(current.current.id, recording.blob, {
          requestId: recording.id,
          expectedVersion: current.current.version,
          durationSeconds: recording.durationSeconds,
        });
        accept(next);
      } catch (error) {
        if (error instanceof DailyRequestError && error.status === 409)
          await reload().catch(() => {});
        throw error;
      } finally {
        lock.current = false;
        if (alive.current) setBusy("");
      }
    },
    [accept, reload],
  );
  const blocked = !!busy || !!lesson?.pending;
  return (
    <div className="daily-workspace">
      {id && (
        <a className="daily-back" href="#/daily">
          <ArrowLeft size={16} />
          全部听后练习
        </a>
      )}
      <div className="page-heading">
        <div>
          <h1>
            {id
              ? lesson?.content?.title || lesson?.source.title || "听后练习"
              : "听完之后，接着用英语。"}
          </h1>
          <p>
            {id && lesson
              ? `来自 ${lesson.source.title} · Part ${lesson.source.part}`
              : "每次听力完成作答后，自动准备一份阅读、主题交流和写作练习。"}
          </p>
        </div>
      </div>
      {error && (
        <div className="daily-alert" role="alert">
          <span>{error}</span>
          <button
            onClick={() => {
              setError("");
              void reload().catch((e) => setError(e.message));
            }}
          >
            重新载入
          </button>
          {hasRetry && (
            <button
              disabled={blocked}
              onClick={() => {
                const previous = retry.current;
                if (previous) void send(previous.action, previous.body, true);
              }}
            >
              重试上次操作
            </button>
          )}
        </div>
      )}
      {loading ? (
        <p className="loading" role="status">
          正在载入听后练习…
        </p>
      ) : !id ? (
        <>
          {!capabilities.runtime && (
            <div className="daily-service-note" role="status">
              <strong>AI 服务尚未配置</strong>
              <p>
                听力作答会照常保存。连接 AI
                服务后，可在这里重试生成；不会用示例内容代替你的练习。
              </p>
            </div>
          )}
          {lessons.length ? (
            <div className="daily-library">
              {lessons.map((entry) => (
                <a
                  className="daily-lesson-row"
                  key={entry.id}
                  href={`#/daily/${encodeURIComponent(entry.id)}`}
                >
                  <span className="daily-part">Part {entry.source.part}</span>
                  <div>
                    <h2>{entry.content?.title || entry.source.title}</h2>
                    <p>
                      {entry.source.title} · {dateLabel(entry.createdAt)}
                    </p>
                  </div>
                  <span className={`daily-state daily-state-${entry.status}`}>
                    {dailyStatusText[entry.status]}
                  </span>
                  <ChevronRight size={18} />
                </a>
              ))}
            </div>
          ) : (
            <div className="daily-empty">
              <HeadphonesIntro />
              <h2>从一份听力开始</h2>
              <p>
                完成听力并提交作答后，这里会出现与原文关联的练习。你可以先核对答案，再按自己的节奏继续。
              </p>
              <a className="button" href="#/library/listening">
                选择听力材料
              </a>
            </div>
          )}
        </>
      ) : lesson ? (
        <>
          <div className="daily-context">
            <span>Part {lesson.source.part}</span>
            <p>
              {
                partDescriptions[
                  Math.min(3, Math.max(0, lesson.source.part - 1))
                ]
              }
            </p>
            <span>口语训练目标 6.5</span>
          </div>
          <p className="daily-boundary">
            难度随听力 Part 递进。目标用于安排练习，不代表当前成绩或官方评分。
          </p>
          {lesson.status !== "ready" && (
            <section className="daily-service-note">
              <h2>{dailyStatusText[lesson.status]}</h2>
              <p>
                {dailyErrorText(lesson.error) ||
                  (lesson.status === "blocked"
                    ? "听力作答已经保存。配置 AI 服务后，可重试准备练习。"
                    : "你可以离开此页，之后从听后练习继续。")}
              </p>
              {["blocked", "failed"].includes(lesson.status) && (
                <button
                  disabled={blocked}
                  onClick={() => void send("retry", {})}
                >
                  <RotateCcw size={15} />
                  重试生成
                </button>
              )}
            </section>
          )}
          {lesson.content && (
            <>
              <div
                className="daily-tabs"
                role="tablist"
                aria-label="听后练习内容"
              >
                {(
                  [
                    ["reading", BookOpen, "阅读理解"],
                    ["conversation", MessageCircle, "主题交流"],
                    ["writing", PenLine, "写作练习"],
                  ] as const
                ).map(([key, Icon, label]) => (
                  <button
                    key={key}
                    role="tab"
                    aria-selected={tab === key}
                    aria-controls={`daily-panel-${key}`}
                    onClick={() => setTab(key)}
                  >
                    <Icon size={17} />
                    {label}
                  </button>
                ))}
              </div>
              {lesson.pending && (
                <p className="daily-working" role="status">
                  {lesson.pending.kind === "conversation"
                    ? "老师正在回应…"
                    : lesson.pending.kind === "expression"
                      ? "正在整理你的英文表达…"
                      : lesson.pending.kind === "writing"
                        ? "正在阅读你的写作…"
                        : lesson.pending.kind === "transcription"
                          ? "录音已保存，正在识别…"
                          : lesson.pending.kind === "speech"
                            ? "正在准备老师语音…"
                            : "正在准备练习…"}{" "}
                  已保存请求，可以稍后继续。
                </p>
              )}
              {!lesson.pending &&
                dailyErrorText(lesson.error) &&
                lesson.status === "ready" && (
                  <div className="daily-alert" role="alert">
                    {dailyErrorText(lesson.error)}
                    <button
                      disabled={blocked}
                      onClick={() => void send("retry", {})}
                    >
                      重试未完成的操作
                    </button>
                  </div>
                )}
              <section
                role="tabpanel"
                id={`daily-panel-${tab}`}
                aria-label={
                  tab === "reading"
                    ? "阅读理解"
                    : tab === "conversation"
                      ? "主题交流"
                      : "写作练习"
                }
              >
                {tab === "reading" ? (
                  <Reading lesson={lesson} disabled={blocked} send={send} />
                ) : tab === "conversation" ? (
                  <Conversation
                    lesson={lesson}
                    confirmedRequest={confirmedConversation}
                    capabilities={capabilities}
                    disabled={blocked}
                    send={send}
                    upload={acceptRecording}
                  />
                ) : (
                  <Writing lesson={lesson} disabled={blocked} send={send} />
                )}
              </section>
            </>
          )}
        </>
      ) : (
        <p className="daily-empty">没有找到这份练习，请从列表重新打开。</p>
      )}
    </div>
  );
}

function HeadphonesIntro() {
  return <BookOpen size={32} strokeWidth={1.3} aria-hidden="true" />;
}
type Send = (
  action: string,
  body: Record<string, unknown>,
  reuse?: boolean,
) => Promise<boolean>;

/** Immediate owner-scoped backup, with explicit server writes independent of React polling. */
function useDraft<T>(
  lesson: DailyLesson,
  section: string,
  initial: T,
  send: Send,
) {
  const { userId } = useRuntime();
  const key = `ielts-daily:${userId || "local"}:${lesson.id}:${section}`;
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved ? JSON.parse(saved) : initial;
    } catch {
      return initial;
    }
  });
  const [state, setState] = useState("");
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(value);
  latest.current = value;
  const update = (next: T) => {
    dirty.current = true;
    latest.current = next;
    setValue(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setState("草稿已保存在此浏览器");
    } catch {
      setState("浏览器未能保存草稿，请先提交");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!dirty.current || lesson.pending) return;
      void send("draft", {
        section,
        ...(next as Record<string, unknown>),
      }).then((ok) => {
        if (ok && JSON.stringify(latest.current) === JSON.stringify(next)) {
          dirty.current = false;
          setState("草稿已保存");
        } else setState("草稿保留在此浏览器，稍后可继续");
      });
    }, 1200);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  const clear = () => {
    dirty.current = false;
    clearTimeout(timer.current);
    try {
      localStorage.removeItem(key);
    } catch {
      /* server copy remains */
    }
    setState("");
  };
  return { value, update, clear, state };
}

function Reading({
  lesson,
  disabled,
  send,
}: {
  lesson: DailyLesson;
  disabled: boolean;
  send: Send;
}) {
  const reading = lesson.content!.reading;
  const submitted = lesson.reading?.attempts?.at(-1);
  const draft = useDraft(
    lesson,
    "reading",
    { answers: lesson.reading?.draft?.answers || {} },
    send,
  );
  const answers = submitted?.answers || draft.value.answers;
  const complete = reading.questions.every(
    (q) =>
      !!answers[q.id]?.trim() &&
      (q.kind !== "gap" ||
        answers[q.id].trim().split(/\s+/).length <= q.max_words),
  );
  return (
    <div className="daily-reading">
      <article className="daily-passage">
        <h2>听力原文</h2>
        <DailyPassage lessonId={lesson.id} text={reading.passage} />
        <details>
          <summary>查看中文意思</summary>
          <p>{reading.translation}</p>
        </details>
      </article>
      <div className="daily-questions">
        <div className="daily-section-heading">
          <h2>读懂之后，再选答案</h2>
          <span>{reading.questions.length} 题</span>
        </div>
        {reading.questions.map((question, index) => {
          const result = submitted?.results.find(
            (entry) => entry.id === question.id,
          );
          return (
            <fieldset
              className="daily-question"
              key={question.id}
              disabled={disabled || !!submitted}
            >
              <legend>
                <span>{index + 1}.</span> {question.prompt}
              </legend>
              {question.kind === "gap" ? (
                <label>
                  <span className="daily-answer-rule">
                    不超过 {question.max_words} 个词
                  </span>
                  <input
                    aria-label={`第 ${index + 1} 题答案`}
                    value={answers[question.id] || ""}
                    onChange={(event) =>
                      draft.update({
                        answers: {
                          ...draft.value.answers,
                          [question.id]: event.target.value,
                        },
                      })
                    }
                  />
                </label>
              ) : (
                <div className="daily-options">
                  {question.options.map((option) => (
                    <label key={option}>
                      <input
                        type="radio"
                        name={`daily-${question.id}`}
                        value={option}
                        checked={answers[question.id] === option}
                        onChange={() =>
                          draft.update({
                            answers: {
                              ...draft.value.answers,
                              [question.id]: option,
                            },
                          })
                        }
                      />
                      <span>{option}</span>
                    </label>
                  ))}
                </div>
              )}
              {result && (
                <div className="daily-reading-result">
                  <strong
                    className={
                      result.correct ? "daily-correct" : "daily-incorrect"
                    }
                  >
                    {result.correct ? "答对" : "再看一下原文"}
                  </strong>
                  <p>答案：{result.answer}</p>
                  <blockquote lang="en">{result.evidence}</blockquote>
                  <p>{result.explanation}</p>
                </div>
              )}
            </fieldset>
          );
        })}
        {submitted ? (
          <p className="daily-completion" role="status">
            <Check size={17} />
            本次阅读答对 {submitted.score} / {submitted.total}{" "}
            题。原文与解析会保留。
          </p>
        ) : (
          <div className="daily-composer-actions">
            <span role="status">{draft.state}</span>
            <button
              className="button"
              disabled={disabled || !complete}
              onClick={() =>
                void send("reading", { answers: draft.value.answers }).then(
                  (ok) => {
                    if (ok) draft.clear();
                  },
                )
              }
            >
              提交阅读答案
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Conversation({
  lesson,
  confirmedRequest,
  capabilities,
  disabled,
  send,
  upload,
}: {
  lesson: DailyLesson;
  confirmedRequest: string;
  capabilities: DailyCapabilities;
  disabled: boolean;
  send: Send;
  upload: (recording: PendingRecording) => Promise<void>;
}) {
  const plan = lesson.content!.conversation;
  const draft = useDraft(
    lesson,
    "conversation",
    { text: lesson.conversation?.draft?.text || "" },
    send,
  );
  const [audio, setAudio] = useState<{ id: string; url: string } | null>(null);
  const [awaitingAudio, setAwaitingAudio] = useState<string | null>(null);
  const [audioError, setAudioError] = useState("");
  const messages = lesson.conversation?.messages || [];
  const shownMessages = messages.filter(
    (message, index) =>
      !(
        index === 0 &&
        message.role === "assistant" &&
        message.text === plan.opening
      ),
  );
  const previousMessageCount = useRef(messages.length);
  const lastUser = [...messages]
    .reverse()
    .find((message) => message.role === "user" && !message.excluded);
  const finished = lesson.conversation.status === "finished";
  const composerDisabled = disabled || finished;
  useEffect(() => {
    if (
      (messages.length > previousMessageCount.current ||
        lastUser?.id === confirmedRequest) &&
      lastUser?.text === draft.value.text
    ) {
      draft.clear();
      draft.update({ text: "" });
    }
    previousMessageCount.current = messages.length;
  }, [messages.length, lastUser?.id, confirmedRequest]);
  useEffect(() => {
    if (audio && messages.find((message) => message.id === audio.id)?.excluded)
      setAudio(null);
    if (!awaitingAudio) return;
    const message = messages.find((entry) => entry.id === awaitingAudio);
    const url = message?.voiceUrl || message?.audioUrl;
    if (url) {
      if (!document.hidden) setAudio({ id: awaitingAudio, url });
      setAwaitingAudio(null);
    } else if (!lesson.pending && dailyErrorText(lesson.error)) {
      setAudioError(dailyErrorText(lesson.error));
      setAwaitingAudio(null);
    }
  }, [messages, lesson.pending, lesson.error, awaitingAudio]);
  async function play(message: DailyMessage) {
    setAudioError("");
    const existing = message.voiceUrl || message.audioUrl;
    if (existing) {
      setAudio({ id: message.id, url: existing });
      return;
    }
    setAwaitingAudio(message.id);
    if (!(await send("speech", { messageId: message.id })))
      setAwaitingAudio(null);
  }
  return (
    <div className="daily-conversation">
      <header className="daily-conversation-topic">
        <h2>{plan.topic}</h2>
        <p lang="en" className="daily-opening">
          {plan.opening}
        </p>
        <p>{plan.opening_zh}</p>
        {messages[0]?.role === "assistant" && (
          <button
            disabled={disabled || !capabilities.tts}
            onClick={() => void play(messages[0])}
          >
            <Play size={14} />
            听开场问题
          </button>
        )}
        <details>
          <summary>想不到说什么？看看开头</summary>
          {plan.starters.map((starter) => (
            <p lang="en" key={starter}>
              {starter}
            </p>
          ))}
        </details>
      </header>
      <div
        className="daily-conversation-log"
        role="log"
        aria-label="主题交流记录"
      >
        {shownMessages.map((message) => (
          <article
            className={`daily-message daily-message-${message.role}${message.excluded ? " daily-message-excluded" : ""}`}
            key={message.id}
          >
            <span>
              {message.role === "user" ? "我说的" : "老师回复"}
              {message.excluded ? " · 识别有误" : ""}
            </span>
            {message.excluded && message.role === "assistant" ? (
              <p>这次回复对应的识别已标记有误，不再参与后续交流。</p>
            ) : (
              <p lang={message.role === "assistant" ? "en" : undefined}>
                {messageText(message)}
              </p>
            )}
            {message.role === "assistant" && !message.excluded && (
              <>
                {message.followUp && <p lang="en">{message.followUp}</p>}
                {feedbackText(message) && (
                  <p className="daily-feedback-zh">{feedbackText(message)}</p>
                )}
                <button
                  disabled={disabled || !capabilities.tts}
                  onClick={() => void play(message)}
                >
                  <Play size={14} />
                  听老师回复
                </button>
              </>
            )}
            {message.role === "user" && message.audioUrl && (
              <audio
                controls
                preload="none"
                src={message.audioUrl}
                aria-label="我的录音"
              />
            )}
            {message.role === "user" &&
              message.recordingId &&
              (message.excluded ? (
                <p className="daily-feedback-zh">
                  原始录音保留，这次识别不作为学习判断。
                </p>
              ) : (
                <button
                  disabled={disabled}
                  onClick={() =>
                    void send("recognition-error", { messageId: message.id })
                  }
                >
                  识别不对
                </button>
              ))}
          </article>
        ))}
      </div>
      {lesson.recordings
        ?.filter(
          (recording) =>
            !messages.some((message) => message.recordingId === recording.id),
        )
        .map((recording) => (
          <aside className="daily-pending-recording" key={recording.id}>
            <strong>
              {recording.status === "failed"
                ? "录音已保存，识别暂未完成"
                : "原始录音已保存"}
            </strong>
            <p>可以回听；识别失败时不必重新录音，重试未完成的操作即可。</p>
            <audio controls preload="none" src={recording.audioUrl} />
            <a href={recording.audioUrl} download>
              下载原始录音
            </a>
          </aside>
        ))}
      {audio && (
        <audio
          key={audio.url}
          controls
          autoPlay
          src={audio.url}
          onError={() => setAudioError("音频暂时无法播放，请重试准备语音。")}
          aria-label="老师语音"
        />
      )}
      {audioError && (
        <p className="daily-alert" role="alert">
          {audioError}
        </p>
      )}
      {lesson.expressionHelp && (
        <aside className="daily-expression-help">
          <h3>把你的意思，用英语说出来</h3>
          <p lang={lesson.expressionHelp.english ? "en" : "zh"}>
            {lesson.expressionHelp.english ||
              lesson.expressionHelp.clarification_zh}
          </p>
        </aside>
      )}
      <div className="daily-conversation-composer">
        <label htmlFor="daily-conversation-text">接着聊一聊</label>
        <textarea
          id="daily-conversation-text"
          value={draft.value.text}
          maxLength={3000}
          rows={3}
          disabled={composerDisabled}
          onChange={(event) => draft.update({ text: event.target.value })}
          placeholder="用英语聊，也可以用中文问怎么表达…"
        />
        <div className="daily-composer-actions">
          <span role="status">{draft.state}</span>
          <button
            disabled={
              composerDisabled || !(draft.value.text.trim() || lastUser?.text)
            }
            onClick={() =>
              void send("expression-help", {
                text: draft.value.text.trim() || lastUser?.text || "",
              })
            }
          >
            帮我用英语表达
          </button>
          <button
            className="button"
            disabled={composerDisabled || !draft.value.text.trim()}
            onClick={() =>
              void send("conversation", { text: draft.value.text.trim() }).then(
                (ok) => {
                  if (ok) {
                    draft.clear();
                    draft.update({ text: "" });
                  }
                },
              )
            }
          >
            发送
          </button>
        </div>
        <DailyRecorder
          lessonId={lesson.id}
          disabled={composerDisabled}
          available={capabilities.asr}
          upload={upload}
        />
        {!capabilities.tts && (
          <p className="daily-boundary">
            老师语音尚未配置，可以先阅读文字回复。
          </p>
        )}
        <div className="daily-conversation-end">
          <p className="daily-boundary">
            {finished
              ? "本次交流已结束，记录与草稿保留。结束练习不等于已经掌握。"
              : "随时可以停下来，之后从这份练习继续。交流记录会保存。"}
          </p>
          <button
            disabled={disabled}
            onClick={() =>
              void send("conversation-state", {
                state: finished ? "active" : "finished",
              })
            }
          >
            {finished ? "继续这次交流" : "结束本次交流"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Writing({
  lesson,
  disabled,
  send,
}: {
  lesson: DailyLesson;
  disabled: boolean;
  send: Send;
}) {
  const draft = useDraft(
    lesson,
    "writing",
    {
      text: lesson.writing?.draft?.text || "",
      level: lesson.writing?.draft?.level || ("basic" as WritingLevel),
    },
    send,
  );
  const [question, setQuestion] = useState("");
  const tasks = lesson.content!.writing.tasks;
  const task =
    tasks.find((entry) => entry.level === draft.value.level) || tasks[0];
  const submissions = (lesson.writing?.submissions || []).filter(
    (entry) => entry.level === task.level && entry.action !== "ask",
  );
  return (
    <div className="daily-writing">
      <div className="daily-levels" aria-label="写作层次">
        {tasks.map((entry) => (
          <button
            key={entry.level}
            aria-pressed={task.level === entry.level}
            disabled={disabled}
            onClick={() => draft.update({ ...draft.value, level: entry.level })}
          >
            {levelNames[entry.level]}
          </button>
        ))}
      </div>
      <section className="daily-writing-prompt">
        <h2>{task.instruction}</h2>
        <p>{task.goal}</p>
        <details>
          <summary>需要一点提示</summary>
          {task.hints.map((hint) => (
            <p key={hint}>{hint}</p>
          ))}
        </details>
      </section>
      {submissions.map((submission, index) => (
        <article className="daily-writing-feedback" key={submission.id}>
          <span>第 {index + 1} 次表达</span>
          <p lang="en" className="daily-student-writing">
            {submission.text}
          </p>
          {submission.feedback ? (
            <>
              <h3>老师的反馈</h3>
              <p>{submission.feedback.feedback_zh}</p>
              {submission.feedback.corrections.length > 0 && (
                <div>
                  <h4>需要修改</h4>
                  {submission.feedback.corrections.map((correction, i) => (
                    <div className="daily-correction" key={i}>
                      <p lang="en">
                        <del>{correction.original}</del>
                      </p>
                      <p lang="en">{correction.corrected}</p>
                      <p>{correction.reason_zh}</p>
                    </div>
                  ))}
                </div>
              )}
              {submission.feedback.suggestion_en && (
                <details>
                  <summary>看看更自然的表达</summary>
                  <p lang="en">{submission.feedback.suggestion_en}</p>
                </details>
              )}
              <p>{submission.feedback.follow_up_zh}</p>
              <span>
                {submission.feedback.task_complete
                  ? "这次表达已完成任务"
                  : "可以参考反馈，继续修改"}
              </span>
            </>
          ) : (
            <p>回答已保存，等待反馈。</p>
          )}
        </article>
      ))}
      <label htmlFor="daily-writing-text">写下你的表达</label>
      <textarea
        id="daily-writing-text"
        value={draft.value.text}
        maxLength={3000}
        rows={5}
        disabled={disabled}
        onChange={(event) =>
          draft.update({ ...draft.value, text: event.target.value })
        }
        placeholder="先自己写，卡住时再看提示。"
      />
      <div className="daily-composer-actions">
        <span role="status">{draft.state}</span>
        <button
          className="button"
          disabled={disabled || !draft.value.text.trim()}
          onClick={() =>
            void send("writing", {
              text: draft.value.text.trim(),
              level: task.level,
              action: "attempt",
            }).then((ok) => {
              if (ok) draft.clear();
            })
          }
        >
          请老师看看
        </button>
      </div>
      {submissions.length > 0 && (
        <section className="daily-writing-discussion">
          <h3>继续问老师</h3>
          {lesson.writing.discussion?.map((entry) => (
            <article key={entry.id}>
              <p>你问：{entry.question}</p>
              <p>{entry.answer}</p>
            </article>
          ))}
          <label htmlFor="daily-writing-question">对这次修改有什么疑问？</label>
          <textarea
            id="daily-writing-question"
            value={question}
            rows={2}
            disabled={disabled}
            maxLength={2000}
            onChange={(event) => setQuestion(event.target.value)}
          />
          <button
            disabled={disabled || !question.trim()}
            onClick={() =>
              void send("writing", {
                text: question.trim(),
                question: question.trim(),
                level: task.level,
                action: "ask",
              }).then((ok) => {
                if (ok) setQuestion("");
              })
            }
          >
            发送问题
          </button>
        </section>
      )}
    </div>
  );
}

function DailyRecorder({
  lessonId,
  disabled,
  available,
  upload,
}: {
  lessonId: string;
  disabled: boolean;
  available: boolean;
  upload: (recording: PendingRecording) => Promise<void>;
}) {
  const { userId } = useRuntime();
  const owner = userId || "local";
  const itemId = `daily:${lessonId}`;
  const [recording, setRecording] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [pending, setPending] = useState<PendingRecording[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [unsafe, setUnsafe] = useState(false);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const started = useRef(0);
  const alive = useRef(true);
  const shouldSend = useRef(false);
  const urlRef = useRef<Record<string, string>>({});
  const saveRef = useRef<(row: PendingRecording) => Promise<void>>(
    async () => {},
  );
  function add(row: PendingRecording) {
    if (!alive.current) return;
    const url = URL.createObjectURL(row.blob);
    urlRef.current[row.id] = url;
    setUrls({ ...urlRef.current });
    setPending((rows) => [...rows.filter((entry) => entry.id !== row.id), row]);
  }
  useEffect(() => {
    if (!recording && !requesting && !unsafe) return;
    const leaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    addEventListener("beforeunload", leaving);
    return () => removeEventListener("beforeunload", leaving);
  }, [recording, requesting, unsafe]);
  useEffect(() => {
    alive.current = true;
    void listPendingRecordings(owner, itemId)
      .then((rows) => {
        if (alive.current) rows.forEach(add);
      })
      .catch(() => {
        if (alive.current) setError("浏览器暂时不能恢复待发送录音。");
      });
    const hidden = () => {
      if (document.hidden && recorder.current?.state === "recording") {
        shouldSend.current = false;
        recorder.current.stop();
      }
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      alive.current = false;
      shouldSend.current = false;
      if (recorder.current?.state === "recording") recorder.current.stop();
      stream.current?.getTracks().forEach((track) => track.stop());
      document.removeEventListener("visibilitychange", hidden);
      Object.values(urlRef.current).forEach(URL.revokeObjectURL);
    };
  }, [owner, itemId]);
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => {
      const seconds = Math.floor((Date.now() - started.current) / 1000);
      setElapsed(seconds);
      if (seconds >= 60 && recorder.current?.state === "recording") {
        shouldSend.current = !document.hidden;
        recorder.current.stop();
      }
    }, 250);
    return () => clearInterval(timer);
  }, [recording]);
  async function save(row: PendingRecording) {
    if (busy || disabled) return;
    setBusy(true);
    setError("");
    try {
      await upload(row);
      await removePendingRecording(row.id);
      if (alive.current) {
        setPending((rows) => rows.filter((entry) => entry.id !== row.id));
        setUnsafe(false);
      }
    } catch (error) {
      if (alive.current)
        setError(
          `${error instanceof Error ? error.message : "录音上传失败"} 原始录音仍保留，可以重试。`,
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  saveRef.current = save;
  async function start() {
    setError("");
    setRequesting(true);
    try {
      const next = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!alive.current) {
        next.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = next;
      const device = new MediaRecorder(next);
      recorder.current = device;
      const chunks: Blob[] = [];
      device.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      device.onstop = () => {
        next.getTracks().forEach((track) => track.stop());
        if (alive.current) setRecording(false);
        const blob = new Blob(chunks, {
          type: device.mimeType || chunks[0]?.type || "audio/webm",
        });
        if (!blob.size) {
          if (alive.current) setError("刚才没有录到声音，请重试。");
          return;
        }
        const row: PendingRecording = {
          id: crypto.randomUUID(),
          owner,
          itemId,
          question: 0,
          durationSeconds: Math.max(
            1,
            Math.round((Date.now() - started.current) / 1000),
          ),
          createdAt: new Date().toISOString(),
          blob,
        };
        const autoSend =
          shouldSend.current && alive.current && !document.hidden;
        shouldSend.current = false;
        add(row);
        if (alive.current) setUnsafe(true);
        void stashRecording(row)
          .then(() => {
            if (alive.current) setUnsafe(false);
            if (autoSend) void saveRef.current(row);
          })
          .catch(() => {
            if (alive.current)
              setError("录音尚未保存到浏览器，请下载保留后再发送。");
          });
      };
      started.current = Date.now();
      setElapsed(0);
      setRecording(true);
      device.start();
    } catch {
      setError("无法开始录音，请检查麦克风权限，也可以用文字继续。");
    } finally {
      if (alive.current) setRequesting(false);
    }
  }
  const supported =
    typeof MediaRecorder !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia;
  return (
    <div className="daily-recorder">
      <div className="daily-recorder-actions">
        <button
          disabled={
            !recording &&
            (disabled ||
              busy ||
              requesting ||
              !available ||
              !supported ||
              pending.length > 0)
          }
          onClick={() => {
            if (recording) {
              shouldSend.current = true;
              recorder.current?.stop();
            } else void start();
          }}
        >
          {recording ? <Square size={15} /> : <Mic size={15} />}
          {recording
            ? `说完并发送 ${elapsed}s / 60s`
            : requesting
              ? "等待麦克风权限…"
              : "用语音回答"}
        </button>
        {!available && <span>语音识别尚未配置，可以先用文字交流。</span>}
      </div>
      {available && !supported && (
        <p className="daily-boundary">
          当前浏览器不能录音，可以用文字继续交流。
        </p>
      )}
      {pending.map((row) => (
        <div key={row.id} className="daily-pending-recording">
          <p>待发送的原始录音 · {row.durationSeconds} 秒</p>
          <audio controls src={urls[row.id]} />
          <div>
            <a
              href={urls[row.id]}
              download={`daily-recording-${row.id}.${row.blob.type.includes("wav") ? "wav" : "webm"}`}
            >
              下载保留
            </a>
            <button
              disabled={disabled || busy || !available}
              onClick={() => void save(row)}
            >
              {busy ? "正在保存…" : "重试上传录音"}
            </button>
          </div>
        </div>
      ))}
      {error && (
        <p className="daily-alert" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
