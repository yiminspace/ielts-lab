import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  ClipboardCheck,
  Download,
  Menu,
  NotebookPen,
  X,
} from "lucide-react";
import type { StudyItem } from "../types";
import { RichText } from "../lib/content";
import {
  getProgress,
  recordAttempt,
  saveDraftIfCurrent,
  useProgress,
  useSaveError,
} from "../lib/progress";
import { countWords, formatTime } from "../lib/study.mjs";
import {
  writingClock,
  writingLimit,
  writingDraftRevision,
  writingRevisionMatches,
  writingCanRecord,
} from "../lib/computer-writing.mjs";
import "../computer-writing.css";

type WritingDraft = {
  version: 1;
  mode: "single-task-writing";
  status: "ready" | "running" | "finished";
  text: string;
  notes: string;
  limitMinutes: 0 | 20 | 40;
  startedAt: number | null;
  deadlineAt: number | null;
  finishedAt: number | null;
  finishReason: "manual" | "time-expired" | null;
  runId: string;
  attemptRecorded: boolean;
  revision?: string;
};
type OptionsPage = "menu" | "contrast" | "text-size" | null;
type Contrast = "black-white" | "white-black" | "yellow-black";
type TextSize = "regular" | "large" | "extra-large";

function freshDraft(): WritingDraft {
  return {
    version: 1,
    mode: "single-task-writing",
    status: "ready",
    text: "",
    notes: "",
    limitMinutes: 0,
    startedAt: null,
    deadlineAt: null,
    finishedAt: null,
    finishReason: null,
    runId: "",
    attemptRecorded: false,
  };
}
function readDraft(saved: any): WritingDraft {
  if (
    !saved ||
    saved.mode !== "single-task-writing" ||
    !["ready", "running", "finished"].includes(saved.status)
  )
    return freshDraft();
  const draft: WritingDraft = {
    ...freshDraft(),
    ...saved,
    text: typeof saved.text === "string" ? saved.text : "",
    notes: typeof saved.notes === "string" ? saved.notes : "",
    limitMinutes: writingLimit(saved.limitMinutes),
    startedAt:
      typeof saved.startedAt === "number" && Number.isFinite(saved.startedAt)
        ? saved.startedAt
        : null,
    deadlineAt:
      typeof saved.deadlineAt === "number" && Number.isFinite(saved.deadlineAt)
        ? saved.deadlineAt
        : null,
    finishedAt:
      typeof saved.finishedAt === "number" && Number.isFinite(saved.finishedAt)
        ? saved.finishedAt
        : null,
  };
  if (
    draft.status !== "ready" &&
    (!draft.startedAt || typeof draft.runId !== "string" || !draft.runId)
  )
    return freshDraft();
  if (draft.limitMinutes && draft.startedAt)
    draft.deadlineAt = draft.startedAt + draft.limitMinutes * 60000;
  else draft.deadlineAt = null;
  return draft;
}

function ComputerWritingSession({
  item,
  onExit,
}: {
  item: StudyItem;
  onExit: () => void;
}) {
  const key = `exam:${item.id}`;
  const [initial] = useState(() => {
    const raw = getProgress().drafts[key];
    return {
      draft: readDraft(raw),
      snapshot: JSON.stringify(raw ?? null),
      revision: writingDraftRevision(raw),
    };
  });
  const [draft, setDraft] = useState<WritingDraft>(initial.draft);
  const draftRef = useRef(draft);
  const expectedSnapshot = useRef(initial.snapshot);
  const expectedRevision = useRef(initial.revision);
  const writeQueue = useRef<Promise<unknown>>(Promise.resolve());
  const conflictRef = useRef(false);
  const [conflict, setConflict] = useState(false);
  const [pendingWrites, setPendingWrites] = useState(0);
  const progress = useProgress();
  const [now, setNow] = useState(Date.now());
  const [options, setOptions] = useState<OptionsPage>(null);
  const [contrast, setContrast] = useState<Contrast>("black-white");
  const [textSize, setTextSize] = useState<TextSize>("regular");
  const [notesOpen, setNotesOpen] = useState(false);
  const [submissionOpen, setSubmissionOpen] = useState(false);
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [confirmExit, setConfirmExit] = useState(false);
  const saveError = useSaveError();
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const optionsRef = useRef<HTMLElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const part = Number(item.data?.writingPart) === 1 ? 1 : 2;
  const recommended = part === 1 ? 20 : 40;
  const minimum = part === 1 ? 150 : 250;
  const words = countWords(draft.text);
  const clock = writingClock(
    draft.startedAt,
    draft.deadlineAt,
    draft.finishedAt,
    now,
  );
  const prompt =
    item.data?.writingQuestion ||
    item.data?.writingQuestionText ||
    item.data?.prompt ||
    "";

  function showConflict() {
    conflictRef.current = true;
    setConflict(true);
    setOptions(null);
    setConfirmFinish(false);
    setConfirmExit(false);
  }
  function isCurrent() {
    if (conflictRef.current) return false;
    if (
      !writingRevisionMatches(
        expectedRevision.current,
        getProgress().drafts[key],
      )
    ) {
      showConflict();
      return false;
    }
    return true;
  }
  function enqueue<T>(operation: () => T): Promise<T> {
    const run = () =>
      navigator.locks
        ? navigator.locks.request(`ielts-lab-draft:${key}`, operation)
        : Promise.resolve(operation());
    const result = writeQueue.current.catch(() => {}).then(run);
    writeQueue.current = result;
    return result;
  }
  function commit(next: WritingDraft): boolean {
    if (
      !isCurrent() ||
      !saveDraftIfCurrent(key, next, expectedSnapshot.current)
    ) {
      showConflict();
      return false;
    }
    expectedSnapshot.current = JSON.stringify(next);
    expectedRevision.current = writingDraftRevision(next);
    return true;
  }
  function persist(
    next: WritingDraft,
    optimistic = true,
  ): Promise<WritingDraft | null> {
    if (conflictRef.current) return Promise.resolve(null);
    const revisioned = { ...next, revision: crypto.randomUUID() };
    draftRef.current = revisioned;
    if (optimistic) setDraft(revisioned);
    setPendingWrites((n) => n + 1);
    return enqueue(() => {
      if (!commit(revisioned)) return null;
      if (!optimistic) setDraft(revisioned);
      return revisioned;
    })
      .catch(() => {
        showConflict();
        return null;
      })
      .finally(() => setPendingWrites((n) => n - 1));
  }
  async function recordCompleted(completed: WritingDraft) {
    if (!completed.runId || completed.status !== "finished") return;
    await enqueue(() => {
      if (!isCurrent()) return;
      const current = getProgress().drafts[key] as WritingDraft;
      if (
        !writingCanRecord(expectedRevision.current, current, completed.runId)
      ) {
        showConflict();
        return;
      }
      const exists = getProgress().attempts.some(
        (a) =>
          a.itemId === item.id && a.answers?.writingSession === current.runId,
      );
      if (!exists) {
        const duration = writingClock(
          current.startedAt,
          current.deadlineAt,
          current.finishedAt,
        ).elapsedSeconds;
        recordAttempt({
          itemId: item.id,
          title: item.title,
          kind: "writing",
          durationSeconds: duration,
          answers: {
            essay: current.text,
            notes: current.notes,
            writingSession: current.runId,
          },
          detail: `机考单题写作 · ${countWords(current.text)} 词 · ${current.finishReason === "time-expired" ? "计时结束自动保存" : "完成练习"}`,
        });
      }
      if (!current.attemptRecorded) {
        const recorded = {
          ...current,
          attemptRecorded: true,
          revision: crypto.randomUUID(),
        };
        if (commit(recorded)) {
          draftRef.current = recorded;
          setDraft(recorded);
        }
      }
    }).catch(() => showConflict());
  }
  async function finish(reason: "manual" | "time-expired") {
    const current = draftRef.current;
    if (current.status !== "running" || conflictRef.current) return;
    if (current.deadlineAt && Date.now() >= current.deadlineAt)
      reason = "time-expired";
    const finishedAt =
      reason === "time-expired" && current.deadlineAt
        ? current.deadlineAt
        : Date.now();
    const completed: WritingDraft = {
      ...current,
      status: "finished",
      finishedAt,
      finishReason: reason,
    };
    const stored = await persist(completed, false);
    if (!stored) return;
    await recordCompleted(stored);
    setOptions(null);
    setNotesOpen(false);
    setSubmissionOpen(false);
    setConfirmFinish(false);
    setConfirmExit(false);
  }
  function checkDeadline() {
    if (conflictRef.current) return true;
    const current = draftRef.current;
    if (
      current.status === "running" &&
      current.deadlineAt &&
      Date.now() >= current.deadlineAt
    ) {
      finish("time-expired");
      return true;
    }
    return false;
  }
  function edit(field: "text" | "notes", value: string) {
    if (draftRef.current.status !== "running" || checkDeadline()) return;
    persist({ ...draftRef.current, [field]: value });
  }
  function start() {
    if (conflictRef.current) return;
    const startTime = Date.now();
    const limit = writingLimit(draftRef.current.limitMinutes);
    persist({
      ...draftRef.current,
      status: "running",
      startedAt: startTime,
      deadlineAt: limit ? startTime + limit * 60000 : null,
      finishedAt: null,
      finishReason: null,
      runId: crypto.randomUUID(),
      attemptRecorded: false,
    });
    setNow(startTime);
  }
  function exportEssay() {
    const url = URL.createObjectURL(
      new Blob([draftRef.current.text], { type: "text/plain;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${item.title.replace(/[\\/:*?"<>|]/g, "-")}.txt`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function reloadLatest() {
    await writeQueue.current.catch(() => {});
    const latest = getProgress().drafts[key];
    expectedSnapshot.current = JSON.stringify(latest ?? null);
    expectedRevision.current = writingDraftRevision(latest);
    const current = readDraft(latest);
    draftRef.current = current;
    setDraft(current);
    conflictRef.current = false;
    setConflict(false);
    setNow(Date.now());
    setSubmissionOpen(false);
    setNotesOpen(false);
  }

  useEffect(() => {
    if (!writingRevisionMatches(expectedRevision.current, progress.drafts[key]))
      showConflict();
  }, [progress.drafts[key]]);

  useEffect(() => {
    if (draft.status !== "running") return;
    const tick = () => {
      setNow(Date.now());
      checkDeadline();
    };
    tick();
    const interval = window.setInterval(tick, 500);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [draft.status]);
  useEffect(() => {
    if (draft.status === "finished" && !draft.attemptRecorded)
      recordCompleted(draft);
  }, [draft.status, draft.attemptRecorded, draft.runId, conflict]);
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);
  useEffect(() => {
    if (draft.status === "running" && !submissionOpen && !options)
      editorRef.current?.focus();
  }, [draft.status, submissionOpen]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (confirmFinish) setConfirmFinish(false);
      else if (confirmExit) setConfirmExit(false);
      else if (options) setOptions(null);
      else setNotesOpen(false);
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [confirmFinish, confirmExit, options]);
  useEffect(() => {
    const modal =
      confirmFinish || confirmExit
        ? dialogRef.current
        : options
          ? optionsRef.current
          : null;
    if (!modal) return;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const focusable = () =>
      Array.from(
        modal.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.getClientRects().length > 0);
    const first = () => focusable()[0] || modal;
    first().focus();
    const keepFocus = (event: FocusEvent) => {
      if (!modal.contains(event.target as Node)) first().focus();
    };
    const trapTab = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const elements = focusable();
      const firstElement = elements[0] || modal;
      const lastElement = elements.at(-1) || modal;
      if (
        !modal.contains(document.activeElement) ||
        (event.shiftKey && document.activeElement === firstElement) ||
        (!event.shiftKey && document.activeElement === lastElement)
      ) {
        event.preventDefault();
        (event.shiftKey ? lastElement : firstElement).focus();
      }
    };
    document.addEventListener("focusin", keepFocus);
    document.addEventListener("keydown", trapTab, true);
    return () => {
      document.removeEventListener("focusin", keepFocus);
      document.removeEventListener("keydown", trapTab, true);
      if (previous?.isConnected) previous.focus();
    };
  }, [options, confirmFinish, confirmExit]);

  const header = (
    <header className="cw-header">
      <button
        className="cw-brand"
        aria-label="Return to learning space"
        onClick={() =>
          draft.status === "running" ? setConfirmExit(true) : onExit()
        }
      >
        IELTS<span> Lab</span>
      </button>
      <div className="cw-identity">
        <strong>Test taker ID</strong>
        <span>Local practice</span>
      </div>
      {draft.status === "running" && (
        <div
          className="cw-timer"
          aria-label={
            clock.remainingSeconds === null
              ? "Untimed practice"
              : "Time remaining"
          }
        >
          {clock.remainingSeconds === null ? (
            <span>Untimed practice</span>
          ) : (
            <>
              <strong>{formatTime(clock.remainingSeconds)}</strong>
              <span>Time remaining</span>
            </>
          )}
        </div>
      )}
      {draft.status !== "ready" && (
        <div className="cw-header-actions">
          <button
            aria-label="Options"
            title="Options"
            onClick={() => setOptions("menu")}
          >
            <Menu size={25} />
          </button>
          {draft.status === "running" && (
            <button
              aria-label="Notes"
              title="Notes"
              aria-pressed={notesOpen}
              onClick={() => setNotesOpen((v) => !v)}
            >
              <NotebookPen size={24} />
            </button>
          )}
        </div>
      )}
    </header>
  );

  return (
    <div className={`computer-writing cw-${contrast} cw-size-${textSize}`}>
      {header}
      {saveError && (
        <div className="cw-save-warning" role="status">
          {saveError}
        </div>
      )}
      {conflict && (
        <div className="cw-conflict" role="alert">
          <p>
            另一窗口已更新这道题，或本次保存未完成。本页已停止保存与提交，避免覆盖其他答案。你可以先导出本页文本，再加载最新草稿。
          </p>
          <div>
            <button className="cw-secondary" onClick={exportEssay}>
              导出本页文本
            </button>
            <button className="cw-primary" onClick={reloadLatest}>
              加载最新草稿
            </button>
          </div>
        </div>
      )}
      {draft.status === "ready" ? (
        <main className="cw-intro">
          <div className="cw-intro-inner">
            <p className="cw-kicker">Single-task practice</p>
            <h1>Writing familiarisation</h1>
            <h2>{item.title}</h2>
            <p>
              This practice contains <strong>Part {part} only</strong>. It is
              not a complete two-task Writing test.
            </p>
            <p>
              本次练习只包含当前一道写作题，默认不计时。你可以熟悉题目与答题区、字数统计、笔记和显示设置。
            </p>
            <ul>
              <li>Write at least {minimum} words.</li>
              <li>Your response is saved automatically as you work.</li>
              <li>Use normal keyboard shortcuts to cut, copy and paste.</li>
              <li>
                Spellcheck and autocorrect are disabled. No automated score is
                provided.
              </li>
            </ul>
            <fieldset className="cw-time-choices">
              <legend>Practice timing</legend>
              {(
                [
                  {
                    value: 0,
                    label: "Untimed",
                    description: "Default familiarisation mode",
                  },
                  {
                    value: 20,
                    label: "20 minutes",
                    description:
                      part === 1
                        ? "Suggested for this task"
                        : "Shorter practice",
                  },
                  {
                    value: 40,
                    label: "40 minutes",
                    description:
                      part === 2
                        ? "Suggested for this task"
                        : "Extended practice",
                  },
                ] as const
              ).map((option) => (
                <label key={option.value}>
                  <input
                    disabled={conflict}
                    type="radio"
                    name="writing-time"
                    value={option.value}
                    checked={draft.limitMinutes === option.value}
                    onChange={() =>
                      persist({
                        ...draftRef.current,
                        limitMinutes: option.value,
                      })
                    }
                  />
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.description}</small>
                  </span>
                </label>
              ))}
            </fieldset>
            {draft.limitMinutes > 0 && (
              <p className="cw-timing-note">
                计时开始后不能暂停；切换页面或刷新时仍继续计时，到时自动保存并结束本题。
              </p>
            )}
            <div className="cw-intro-actions">
              <button className="cw-secondary" onClick={onExit}>
                Back to learning
              </button>
              <button
                className="cw-primary"
                disabled={conflict || pendingWrites > 0}
                onClick={start}
              >
                Start practice <ChevronRight size={20} />
              </button>
            </div>
          </div>
        </main>
      ) : draft.status === "finished" ? (
        <main className="cw-complete">
          <div className="cw-complete-inner">
            <ClipboardCheck size={42} />
            <h1>
              {draft.finishReason === "time-expired"
                ? "Time is up"
                : "Practice completed"}
            </h1>
            <p>
              {draft.attemptRecorded
                ? "Your response has been saved to your practice history."
                : "Saving your response to your practice history…"}
            </p>
            <p className="cw-subtle">
              {draft.finishReason === "time-expired"
                ? "练习已按设定时间自动结束。"
                : "本次单题练习已完成。"}{" "}
              写作未进行自动评分。
            </p>
            <dl className="cw-result-facts">
              <div>
                <dt>Task</dt>
                <dd>Part {part}</dd>
              </div>
              <div>
                <dt>Word count</dt>
                <dd>{words}</dd>
              </div>
              <div>
                <dt>Time spent</dt>
                <dd>{formatTime(clock.elapsedSeconds)}</dd>
              </div>
            </dl>
            <details className="cw-response-review">
              <summary>Review your response</summary>
              <div className="cw-final-essay">
                {draft.text || "No response entered."}
              </div>
              {draft.notes && (
                <>
                  <h3>Your notes</h3>
                  <div className="cw-final-essay">{draft.notes}</div>
                </>
              )}
            </details>
            <div className="cw-complete-actions">
              <button
                className="cw-secondary"
                disabled={!draft.text}
                onClick={exportEssay}
              >
                <Download size={17} /> Download response
              </button>
              <button
                className="cw-secondary"
                disabled={
                  conflict || pendingWrites > 0 || !draft.attemptRecorded
                }
                onClick={() => {
                  persist(freshDraft());
                  setOptions(null);
                  setNotesOpen(false);
                  setSubmissionOpen(false);
                }}
              >
                Start another practice
              </button>
              <button className="cw-primary" onClick={onExit}>
                Back to learning
              </button>
            </div>
          </div>
        </main>
      ) : submissionOpen ? (
        <main className="cw-submission">
          <div className="cw-submission-inner">
            <h1>Review and finish</h1>
            <p>You are completing a single-task Writing practice.</p>
            <button
              className="cw-submission-row"
              onClick={() => setSubmissionOpen(false)}
            >
              <span>
                <strong>Part {part}</strong>
                <small>
                  {words ? `${words} words entered` : "No response entered"}
                </small>
              </span>
              <span>
                {words ? "Answered" : "Not answered"} <ChevronRight size={20} />
              </span>
            </button>
            <p className="cw-subtle">
              提交后，作文与本次用时会保存在练习记录中。
              {draft.deadlineAt ? "计时仍在继续。" : ""}
            </p>
            <div className="cw-intro-actions">
              <button
                className="cw-secondary"
                onClick={() => setSubmissionOpen(false)}
              >
                <ArrowLeft size={17} /> Return to question
              </button>
              <button
                className="cw-primary"
                disabled={conflict || pendingWrites > 0}
                onClick={() => setConfirmFinish(true)}
              >
                Finish practice <Check size={20} />
              </button>
            </div>
          </div>
        </main>
      ) : (
        <>
          <main className="cw-test-body">
            <section className="cw-instructions">
              <strong>Part {part}</strong>
              <p>
                You should spend about {recommended} minutes on this task. Write
                at least {minimum} words.
              </p>
            </section>
            <div className="cw-columns">
              <section className="cw-prompt" aria-label="Writing task">
                <h1>Writing Task {part}</h1>
                <RichText html={prompt} />
              </section>
              <section className="cw-answer">
                <label htmlFor="computer-writing-answer">
                  Write your answer below.
                </label>
                <textarea
                  id="computer-writing-answer"
                  ref={editorRef}
                  aria-describedby="computer-writing-word-count"
                  value={draft.text}
                  readOnly={conflict}
                  onChange={(event) => edit("text", event.target.value)}
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  autoComplete="off"
                  data-gramm="false"
                  data-enable-grammarly="false"
                />
                <div className="cw-answer-footer">
                  <span id="computer-writing-word-count">
                    Word count: <strong>{words}</strong>
                  </span>
                  <span className="cw-subtle">
                    {conflict
                      ? "Saving stopped"
                      : pendingWrites > 0
                        ? "Saving…"
                        : "Saved automatically"}
                  </span>
                </div>
              </section>
            </div>
          </main>
          <footer className="cw-navigation">
            <button
              className="cw-task-tab"
              aria-current="page"
              onClick={() => editorRef.current?.focus()}
            >
              <strong>Part {part}</strong>
              <span>{words ? `${words} words` : "Not answered"}</span>
            </button>
            <span className="cw-single-task">Single-task practice</span>
            <button
              className="cw-finish-nav"
              aria-label="Go to submission page"
              title="Go to submission page"
              onClick={() => setSubmissionOpen(true)}
            >
              <Check size={28} />
            </button>
          </footer>
        </>
      )}

      {notesOpen && draft.status === "running" && (
        <aside className="cw-notes" aria-label="Notes">
          <div>
            <h2>Notes</h2>
            <button
              aria-label="Close notes"
              onClick={() => setNotesOpen(false)}
            >
              <X size={21} />
            </button>
          </div>
          <p>
            Notes are saved with this practice. They are not part of your
            response.
          </p>
          <label className="cw-sr-only" htmlFor="computer-writing-notes">
            Your notes
          </label>
          <textarea
            id="computer-writing-notes"
            value={draft.notes}
            readOnly={conflict}
            onChange={(event) => edit("notes", event.target.value)}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
          />
        </aside>
      )}

      {options && (
        <section
          ref={optionsRef}
          tabIndex={-1}
          className="cw-options"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cw-options-title"
        >
          <header>
            <button
              aria-label="Back"
              onClick={() =>
                options === "menu" ? setOptions(null) : setOptions("menu")
              }
            >
              <ArrowLeft size={24} />
            </button>
            <h2 id="cw-options-title">
              {options === "menu"
                ? "Options"
                : options === "contrast"
                  ? "Contrast"
                  : "Text size"}
            </h2>
            <button aria-label="Close options" onClick={() => setOptions(null)}>
              <X size={25} />
            </button>
          </header>
          <div className="cw-option-list">
            {options === "menu" ? (
              <>
                {draft.status === "running" && (
                  <button
                    onClick={() => {
                      setSubmissionOpen(true);
                      setOptions(null);
                      setNotesOpen(false);
                    }}
                  >
                    Go to submission page
                    <ChevronRight size={22} />
                  </button>
                )}
                <button onClick={() => setOptions("contrast")}>
                  Contrast
                  <ChevronRight size={22} />
                </button>
                <button onClick={() => setOptions("text-size")}>
                  Text size
                  <ChevronRight size={22} />
                </button>
              </>
            ) : options === "contrast" ? (
              (
                [
                  ["black-white", "Black on white"],
                  ["white-black", "White on black"],
                  ["yellow-black", "Yellow on black"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  role="radio"
                  aria-checked={contrast === value}
                  onClick={() => setContrast(value)}
                >
                  {label}
                  {contrast === value && <Check size={22} />}
                </button>
              ))
            ) : (
              (
                [
                  ["regular", "Regular"],
                  ["large", "Large"],
                  ["extra-large", "Extra large"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  role="radio"
                  aria-checked={textSize === value}
                  onClick={() => setTextSize(value)}
                >
                  {label}
                  {textSize === value && <Check size={22} />}
                </button>
              ))
            )}
          </div>
        </section>
      )}

      {(confirmFinish || confirmExit) && (
        <div className="cw-dialog-backdrop">
          <section
            ref={dialogRef}
            tabIndex={-1}
            className="cw-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cw-dialog-title"
          >
            <h2 id="cw-dialog-title">
              {confirmFinish ? "Finish this practice?" : "Leave this practice?"}
            </h2>
            <p>
              {confirmFinish
                ? "Your response will be saved to your practice history. You will no longer be able to change this submission."
                : "Your response is saved. You can return to this practice later."}
            </p>
            {confirmExit && draft.deadlineAt && (
              <p>
                Timed practice continues while you are away. Your response will
                be submitted when you return if the deadline has passed.
              </p>
            )}
            {confirmFinish && !words && <p>No response has been entered.</p>}
            <div>
              <button
                className="cw-secondary"
                onClick={() => {
                  setConfirmFinish(false);
                  setConfirmExit(false);
                }}
              >
                Cancel
              </button>
              <button
                className="cw-primary"
                disabled={pendingWrites > 0 || (confirmFinish && conflict)}
                onClick={() => (confirmFinish ? finish("manual") : onExit())}
              >
                {confirmFinish ? "Finish practice" : "Leave practice"}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export default function ComputerWriting(props: {
  item: StudyItem;
  onExit: () => void;
}) {
  return <ComputerWritingSession key={props.item.id} {...props} />;
}
