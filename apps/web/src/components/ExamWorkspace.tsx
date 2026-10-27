import {
  createElement,
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import DOMPurify from "dompurify";
import {
  Bookmark,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Flag,
  Highlighter,
  Pause,
  Play,
  RotateCcw,
  Volume2,
  X,
} from "lucide-react";
import type { Attempt, StudyItem } from "../types";
import { mediaUrl, RichText, textOf } from "../lib/content";
import { getProgress, recordAttempt, saveDraft } from "../lib/progress";
import {
  answerQuotes,
  buildGroups,
  displayAnswer,
  gradeGroups,
  parseTranscript,
  type Grade,
  type QuestionGroup,
  type QuestionRow,
} from "../lib/questions.mjs";
import {
  compactAnswer,
  completedBlankAnswer,
  resolveSolutionLine,
} from "../lib/question-review.mjs";
import {
  scrollQuestionWithinPane,
  splitByKeyboard,
} from "../lib/computer-test.mjs";
import PracticeFrame from "./PracticeFrame";
import "../exam.css";

type Answers = Record<string, string | string[]>;
type Highlight = { id: string; start: number; end: number; text: string };
type GapReview = { summary: ReactNode; details: ReactNode };
type Draft = {
  answers: Answers;
  flags: string[];
  highlights: Highlight[];
  elapsed: number;
  submitted: boolean;
};
const statusText: Record<string, string> = {
  correct: "答对",
  incorrect: "答错",
  blank: "未作答",
  partial: "部分正确",
  manual: "待人工核对",
};
const sanitizeExamHtml = (html: unknown) =>
  DOMPurify.sanitize(String(html || ""), {
    FORBID_TAGS: [
      "script",
      "style",
      "iframe",
      "object",
      "embed",
      "form",
      "input",
      "button",
      "audio",
      "video",
      "source",
    ],
    FORBID_ATTR: ["style", "srcset"],
    ALLOWED_URI_REGEXP:
      /^(?:\/(?!\/)|#|data:image\/(?:png|jpeg|webp);base64,)/i,
  });
function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)
    .toString()
    .padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;
}

/** Parse sanitized rich text into React nodes so blanks remain in their original table or sentence. */
function HtmlContent({
  html,
  item,
  gap,
  gapFeedback,
  highlights = [],
  className = "",
}: {
  html: unknown;
  item: StudyItem;
  gap?: (index: number) => ReactNode;
  gapFeedback?: (index: number) => GapReview | null;
  highlights?: Highlight[];
  className?: string;
}) {
  const root = useMemo(() => {
    const safe = sanitizeExamHtml(html);
    const body = document.createElement("div");
    body.innerHTML = safe;
    return body;
  }, [html]);
  let offset = 0,
    gapIndex = 0,
    keyIndex = 0;
  const placedFeedback = new Set<number>();
  function feedbackSince(start: number) {
    if (!gapFeedback) return null;
    const entries: { index: number; review: GapReview }[] = [];
    for (let index = start; index < gapIndex; index++) {
      if (placedFeedback.has(index)) continue;
      placedFeedback.add(index);
      const feedback = gapFeedback(index);
      if (feedback) entries.push({ index, review: feedback });
    }
    return entries.length ? entries : null;
  }
  function reviewLine(
    content: ReactNode,
    entries: NonNullable<ReturnType<typeof feedbackSince>>,
    key?: number,
  ) {
    return (
      <div
        key={key}
        className={`exam-review-row ${entries.length > 1 ? "exam-review-multiple" : ""}`}
      >
        <div className="exam-review-prompt">{content}</div>
        <div className="exam-review-meta">
          {entries.map(({ index, review }) => (
            <Fragment key={index}>{review.summary}</Fragment>
          ))}
        </div>
        {entries.map(({ index, review }) =>
          review.details ? (
            <div key={index} className="exam-review-details">
              {review.details}
            </div>
          ) : null,
        )}
      </div>
    );
  }
  function render(node: Node): ReactNode {
    const key = keyIndex++;
    if (node.nodeType === Node.TEXT_NODE) {
      const content = node.textContent || "";
      const start = offset;
      offset += content.length;
      if (gap && content.includes("......"))
        return (
          <Fragment key={key}>
            {content
              .split(/(\.{6})/)
              .map((part, i) =>
                part === "......" ? (
                  <Fragment key={i}>{gap(gapIndex++)}</Fragment>
                ) : (
                  part
                ),
              )}
          </Fragment>
        );
      const spans = highlights.filter((h) => h.start < offset && h.end > start);
      if (!spans.length) return content;
      const boundaries = [
        ...new Set([
          0,
          content.length,
          ...spans.flatMap((h) => [
            Math.max(0, h.start - start),
            Math.min(content.length, h.end - start),
          ]),
        ]),
      ].sort((a, b) => a - b);
      return (
        <Fragment key={key}>
          {boundaries.slice(0, -1).map((a, i) => {
            const b = boundaries[i + 1];
            const marked = spans.some(
              (h) => h.start <= start + a && h.end >= start + b,
            );
            return marked ? (
              <mark key={a}>{content.slice(a, b)}</mark>
            ) : (
              content.slice(a, b)
            );
          })}
        </Fragment>
      );
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const element = node as HTMLElement;
    const tag = element.tagName.toLowerCase();
    const props: Record<string, unknown> = { key };
    if (tag === "img") {
      const source = mediaUrl(item, element.getAttribute("src") || "");
      if (!source)
        return (
          <span key={key} className="exam-unavailable">
            [图片未包含在本地资料中]
          </span>
        );
      props.src = source;
      props.alt = element.getAttribute("alt") || "题目图示";
      props.loading = "lazy";
    }
    if (tag === "a") {
      props.href = element.getAttribute("href")?.startsWith("#")
        ? element.getAttribute("href")
        : undefined;
    }
    for (const [attr, reactAttr] of [
      ["colspan", "colSpan"],
      ["rowspan", "rowSpan"],
    ]) {
      const v = element.getAttribute(attr);
      if (v) props[reactAttr] = Number(v);
    }
    if (["br", "hr", "img", "wbr", "col"].includes(tag))
      return createElement(tag, props);
    const firstGap = gapIndex;
    const children = Array.from(node.childNodes).map(render);
    // Group the complete sentence and its review controls in one row. Keep
    // paragraphs intact and never place a wrapper between table/list elements.
    const feedback = ["p", "li", "td", "th", "div", "blockquote"].includes(tag)
      ? feedbackSince(firstGap)
      : null;
    if (feedback && tag === "p")
      return reviewLine(createElement(tag, props, ...children), feedback, key);
    return createElement(
      tag,
      props,
      ...(feedback ? [reviewLine(children, feedback)] : children),
    );
  }
  const children = Array.from(root.childNodes).map(render);
  const remaining = feedbackSince(0);
  return (
    <div className={`exam-rich ${className}`}>
      {remaining ? reviewLine(children, remaining) : children}
    </div>
  );
}

function InlineControl({
  row,
  slot = 0,
  answer,
  setAnswer,
  disabled,
  focused,
  status,
}: {
  row: QuestionRow;
  slot?: number;
  answer: string | string[] | undefined;
  setAnswer: (value: string | string[]) => void;
  disabled: boolean;
  focused?: () => void;
  status?: string;
}) {
  const current =
    row.slots > 1
      ? Array.isArray(answer)
        ? answer[slot] || ""
        : ""
      : String(answer || "");
  return (
    <span
      className={`exam-inline-answer ${status && row.slots === 1 ? `exam-answer-${status}` : ""}`}
      id={slot === 0 ? `question-${row.id}` : undefined}
      tabIndex={-1}
    >
      <span className="exam-inline-number">
        {row.number}
        {row.slots > 1 ? String.fromCharCode(97 + slot) : ""}
      </span>
      {row.type === "4" ? (
        <select
          aria-label={`第 ${row.number} 题答案`}
          disabled={disabled}
          value={String(answer || "")}
          onFocus={focused}
          onChange={(e) => setAnswer(e.target.value)}
        >
          <option value="">选择</option>
          {row.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          aria-label={`第 ${row.number} 题${row.slots > 1 ? `第 ${slot + 1} 空` : ""}答案`}
          autoComplete="off"
          spellCheck={false}
          value={current}
          disabled={disabled}
          onFocus={focused}
          onChange={(e) => {
            if (row.slots > 1) {
              const values = Array.isArray(answer)
                ? [...answer]
                : Array(row.slots).fill("");
              values[slot] = e.target.value;
              setAnswer(values);
            } else setAnswer(e.target.value);
          }}
        />
      )}
      {status && row.slots === 1 && (
        <span className={`exam-inline-status ${status}`}>
          {status === "correct" ? (
            <Check size={14} />
          ) : status === "incorrect" ? (
            <X size={14} />
          ) : null}
          {statusText[status]}
        </span>
      )}
    </span>
  );
}

function CompletedBlank({ row, value }: { row: QuestionRow; value: string }) {
  return (
    <span
      id={`question-${row.id}`}
      className="exam-completed-answer"
      tabIndex={-1}
      aria-label={`第 ${row.number} 题正确答案：${value}`}
    >
      {value}
    </span>
  );
}

export default function ExamWorkspace({
  item,
  reviewAttempt,
  onExit,
  onExam,
}: {
  item: StudyItem;
  reviewAttempt?: Attempt;
  onExit?: () => void;
  onExam?: () => void;
}) {
  return (
    <ExamSession
      key={`${item.id}:${reviewAttempt?.id || "draft"}`}
      item={item}
      reviewAttempt={reviewAttempt}
      onExit={onExit}
      onExam={onExam}
    />
  );
}

function ExamSession({
  item,
  reviewAttempt,
  onExit,
  onExam,
}: {
  item: StudyItem;
  reviewAttempt?: Attempt;
  onExit?: () => void;
  onExam?: () => void;
}) {
  const data = item.data?.data?.questions ? item.data.data : item.data || {};
  const listening = item.kind === "listening";
  const groups = useMemo(() => buildGroups(data), [data]);
  const rows = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  const saved = useMemo<Draft>(() => {
    const current = getProgress().drafts[item.id] || {
      answers: {},
      flags: [],
      highlights: [],
      elapsed: 0,
      submitted: false,
    };
    return reviewAttempt
      ? {
          answers: reviewAttempt.answers || {},
          flags: [],
          highlights: current.highlights || [],
          elapsed: reviewAttempt.durationSeconds || 0,
          submitted: true,
        }
      : current;
  }, [item.id, reviewAttempt]);
  const [reviewing, setReviewing] = useState(!!reviewAttempt);
  const [answers, setAnswers] = useState<Answers>(saved.answers || {});
  const [flags, setFlags] = useState<string[]>(saved.flags || []);
  const [highlights, setHighlights] = useState<Highlight[]>(
    saved.highlights || [],
  );
  const [elapsed, setElapsed] = useState(saved.elapsed || 0);
  const [running, setRunning] = useState(!saved.submitted);
  const [submitted, setSubmitted] = useState(!!saved.submitted);
  const [modal, setModal] = useState<"submit" | "reset" | "exam" | null>(null);
  const [split, setSplit] = useState(50);
  const [active, setActive] = useState(rows[0]?.id || "");
  const [transcriptOpen, setTranscriptOpen] = useState(
    listening && !!saved.submitted,
  );
  const [transcriptTarget, setTranscriptTarget] = useState<{
    index: number;
    number: number;
  } | null>(null);
  const [translation, setTranslation] = useState(false);
  const [passageTranslation, setPassageTranslation] = useState(false);
  const [selection, setSelection] = useState<Omit<Highlight, "id"> | null>(
    null,
  );
  const [focusQuotes, setFocusQuotes] = useState<string[]>([]);
  const [audioTime, setAudioTime] = useState(0);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [playbackQuestion, setPlaybackQuestion] = useState<string | null>(null);
  const [openSolutions, setOpenSolutions] = useState<string[]>([]);
  const [duration, setDuration] = useState(Number(data.seconds) || 0);
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(false);
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const [audioError, setAudioError] = useState("");
  const audio = useRef<HTMLAudioElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const panes = useRef<HTMLDivElement>(null);
  const navigation = useRef<HTMLDivElement>(null);
  const splitCleanup = useRef<(() => void) | null>(null);
  const passage = useRef<HTMLDivElement>(null);
  const passagePanel = useRef<HTMLElement>(null);
  const questionsPanel = useRef<HTMLElement>(null);
  const transcriptPanel = useRef<HTMLElement>(null);
  const draft = useRef<Draft>({
    answers,
    flags,
    highlights,
    elapsed,
    submitted,
  });
  draft.current = { answers, flags, highlights, elapsed, submitted };
  const grade = useMemo<Grade | null>(
    () =>
      submitted && (!reviewing || reviewAttempt?.answers)
        ? gradeGroups(groups, answers)
        : null,
    [submitted, groups, answers, reviewing, reviewAttempt],
  );
  const lines = useMemo(
    () => parseTranscript(data.listenDetail, duration),
    [data.listenDetail, duration],
  );
  const currentLine = lines.findIndex(
    (line, i) =>
      audioTime >= line.start &&
      (audioTime < line.end || i === lines.length - 1),
  );
  const src = mediaUrl(item, data.audioUrl);
  useEffect(() => {
    const player = audio.current;
    if (!listening || saved.submitted || !src || !player) return;
    let cancelled = false;
    void player.play().catch((error: unknown) => {
      if (cancelled) return;
      setAudioError(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "浏览器阻止了自动播放，请点击播放按钮开始听力。"
          : "播放未能启动，请点击音频控件重试。",
      );
    });
    return () => {
      cancelled = true;
      player.pause();
    };
  }, [listening, saved.submitted, src]);
  const completed = rows.filter((r) => {
    const v = answers[r.id];
    return Array.isArray(v) ? v.some(Boolean) : !!v?.trim();
  }).length;
  const fullCount = rows.reduce((n, r) => n + r.weight, 0);
  const resultSummary =
    reviewing && typeof reviewAttempt?.score === "number"
      ? { score: reviewAttempt.score, total: reviewAttempt.total ?? fullCount }
      : grade;
  const recommendedSeconds = listening ? Math.max(duration + 120, 600) : 1200;
  const locatedHighlights = useMemo(() => {
    if (!focusQuotes.length) return [];
    const original = document.createElement("div");
    original.innerHTML = sanitizeExamHtml(data.passagesContent);
    const content = original.textContent || "";
    return focusQuotes.flatMap((text, i) => {
      const start = content.indexOf(text);
      return start < 0
        ? []
        : [{ id: `source-${i}`, start, end: start + text.length, text }];
    });
  }, [focusQuotes, data.passagesContent]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (running && !submitted) setElapsed((v) => v + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [running, submitted]);
  useEffect(() => {
    if (!reviewing) saveDraft(item.id, draft.current);
  }, [item.id, answers, flags, highlights, submitted, reviewing]);
  useEffect(() => {
    if (reviewing) return;
    const timer = setInterval(() => saveDraft(item.id, draft.current), 15000);
    const flush = () => saveDraft(item.id, draft.current);
    window.addEventListener("pagehide", flush);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [item.id, reviewing]);
  useEffect(() => {
    if (audio.current) audio.current.playbackRate = speed;
  }, [speed]);
  useLayoutEffect(() => {
    if (!transcriptOpen || !transcriptTarget) return;
    scrollQuestionWithinPane(
      transcriptPanel.current,
      transcriptPanel.current?.querySelector<HTMLElement>(
        `[id="line-${transcriptTarget.index}"]`,
      ),
    );
  }, [transcriptOpen, transcriptTarget]);
  useEffect(() => {
    if (focusQuotes.length)
      scrollQuestionWithinPane(
        passagePanel.current,
        passage.current?.querySelector<HTMLElement>("mark"),
      );
  }, [focusQuotes]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (modal && !element.open) element.showModal();
    if (!modal && element.open) element.close();
  }, [modal]);
  useEffect(() => () => splitCleanup.current?.(), []);
  useEffect(() => {
    const list = navigation.current;
    const selected = list?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!list || !selected) return;
    const parent = list.getBoundingClientRect();
    const child = selected.getBoundingClientRect();
    if (child.left < parent.left + 3)
      list.scrollLeft += child.left - parent.left - 3;
    else if (child.right > parent.right - 3)
      list.scrollLeft += child.right - parent.right + 3;
  }, [active]);

  function changeSplit(event: ReactPointerEvent<HTMLDivElement>) {
    const bounds = panes.current?.getBoundingClientRect();
    if (!bounds || event.button !== 0) return;
    event.preventDefault();
    splitCleanup.current?.();
    const handle = event.currentTarget;
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) =>
      setSplit(
        Math.max(
          30,
          Math.min(70, ((e.clientX - bounds.left) / bounds.width) * 100),
        ),
      );
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      if (handle.hasPointerCapture(event.pointerId))
        handle.releasePointerCapture(event.pointerId);
      splitCleanup.current = null;
    };
    splitCleanup.current = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
  }
  function setAnswer(row: QuestionRow, value: string | string[]) {
    if (submitted) return;
    setAnswers((old) => ({ ...old, [row.id]: value }));
    setActive(row.id);
  }
  function toggleFlag(id: string) {
    if (submitted) return;
    setFlags((old) =>
      old.includes(id) ? old.filter((x) => x !== id) : [...old, id],
    );
  }
  function go(id: string) {
    setActive(id);
    const target = document.getElementById(`question-${id}`);
    scrollQuestionWithinPane(questionsPanel.current, target);
    const control = target?.querySelector<HTMLElement>(
      "input:not(:disabled), select:not(:disabled)",
    );
    (control || target)?.focus({ preventScroll: true });
  }
  function playLine(index: number, questionId: string | null = null) {
    const line = lines[index];
    if (!line || !audio.current) return;
    if (questionId !== null) setLoop(false);
    setPlaybackQuestion(questionId);
    setSelectedLine(index);
    audio.current.currentTime = line.start;
    audio.current
      .play()
      .catch(() => setAudioError("播放未能启动，请点击音频控件重试。"));
  }
  function tickAudio() {
    const player = audio.current;
    if (!player) return;
    const line = selectedLine !== null ? lines[selectedLine] : null;
    if (playbackQuestion !== null && line && player.currentTime >= line.end) {
      player.pause();
      player.currentTime = line.end;
      setAudioPlaying(false);
      setPlaybackQuestion(null);
    }
    if (
      playbackQuestion === null &&
      loop &&
      selectedLine !== null &&
      lines[selectedLine] &&
      player.currentTime >= lines[selectedLine].end - 0.05
    )
      player.currentTime = lines[selectedLine].start;
    setAudioTime(player.currentTime);
  }
  // timeupdate can be several hundred milliseconds apart. Check question clips
  // more frequently so they stop at the sentence boundary, including at 2×.
  useEffect(() => {
    if (!audioPlaying || playbackQuestion === null) return;
    const timer = window.setInterval(tickAudio, 25);
    return () => window.clearInterval(timer);
  }, [audioPlaying, playbackQuestion, selectedLine, lines, loop]);
  function submit() {
    if (submitted) return;
    const result = gradeGroups(groups, answers);
    recordAttempt({
      itemId: item.id,
      title: item.title,
      kind: item.kind,
      score: result.score,
      total: result.total,
      durationSeconds: elapsed,
      answers,
      detail: result.manual
        ? `${result.manual} 题需人工核对`
        : "按本地标准答案判分",
    });
    setSubmitted(true);
    if (listening) setTranscriptOpen(true);
    setRunning(false);
    setModal(null);
    audio.current?.pause();
  }
  function reset() {
    setReviewing(false);
    setAnswers({});
    setFlags([]);
    setElapsed(0);
    setSubmitted(false);
    setRunning(true);
    setModal(null);
    setFocusQuotes([]);
    setActive(rows[0]?.id || "");
    setTranscriptOpen(false);
    setTranscriptTarget(null);
    setPassageTranslation(false);
    setLoop(false);
    setSelectedLine(null);
    setPlaybackQuestion(null);
    setOpenSolutions([]);
    setAudioTime(0);
    if (audio.current) {
      audio.current.pause();
      audio.current.currentTime = 0;
    }
  }
  function captureSelection() {
    if (reviewing) {
      setSelection(null);
      return;
    }
    const selected = window.getSelection();
    if (
      !selected ||
      !selected.rangeCount ||
      !passage.current ||
      passageTranslation
    ) {
      setSelection(null);
      return;
    }
    const range = selected.getRangeAt(0);
    if (
      !passage.current.contains(range.commonAncestorContainer) ||
      selected.isCollapsed
    ) {
      setSelection(null);
      return;
    }
    const text = selected.toString();
    if (!text.trim() || text.length > 2500) {
      setSelection(null);
      return;
    }
    const prefix = range.cloneRange();
    prefix.selectNodeContents(passage.current);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = prefix.toString().length;
    setSelection({ text, start, end: start + text.length });
  }
  function addHighlight() {
    if (selection) {
      setHighlights((old) => [
        ...old,
        { ...selection, id: crypto.randomUUID() },
      ]);
      setSelection(null);
      window.getSelection()?.removeAllRanges();
    }
  }
  function locate(row: QuestionRow) {
    setActive(row.id);
    if (listening) {
      const index = resolveSolutionLine(row.solution, lines);
      if (index >= 0) {
        if (playbackQuestion === row.id && audioPlaying) {
          audio.current?.pause();
          return;
        }
        setTranscriptOpen(true);
        setTranscriptTarget({ index, number: row.number });
        if (src) playLine(index, row.id);
      }
    } else {
      setPassageTranslation(false);
      setFocusQuotes(answerQuotes(row.solution));
    }
  }
  function solution(
    row: QuestionRow,
    part: "all" | "summary" | "details" = "all",
  ) {
    if (!grade) return null;
    const result = grade.results.find((r) => r.id === row.id);
    const status = result?.status || "manual";
    const expanded = openSolutions.includes(row.id);
    const expected = compactAnswer(row);
    const completed =
      part === "summary" && status !== "manual"
        ? completedBlankAnswer(row)
        : null;
    const label = `第 ${row.number}${row.endNumber > row.number ? `–${row.endNumber}` : ""} 题`;
    const canLocate = listening
      ? !!src && resolveSolutionLine(row.solution, lines) >= 0
      : answerQuotes(row.solution).length > 0;
    const playing = listening && playbackQuestion === row.id && audioPlaying;
    const summary = (
      <div
        className={`exam-solution-heading ${part === "summary" ? "exam-solution-compact" : ""}`}
        data-review-for={part === "summary" ? row.id : undefined}
      >
        {completed !== null ? (
          <div className={`exam-review-attempt ${status}`}>
            <span className="exam-review-number" aria-label={label}>
              {row.number}
            </span>
            <span className={`exam-status ${status}`}>
              {status === "correct" ? (
                <Check size={13} aria-hidden="true" />
              ) : status === "incorrect" ? (
                <X size={13} aria-hidden="true" />
              ) : null}
              {statusText[status]}
            </span>
            <span className="exam-your-answer">
              <span>你填：</span>
              <span className="exam-your-answer-value">
                {displayAnswer(row, answers[row.id] ?? "") || "—"}
              </span>
            </span>
          </div>
        ) : (
          <>
            {(part !== "summary" || row.slots > 1) && (
              <span className={`exam-status ${status}`}>{statusText[status]}</span>
            )}
            <span className="exam-correct-answer">
              <span>
                <span className="exam-review-question-label">{label} · </span>
                {row.slots > 1 ? "两空合并核对 · " : ""}
                {status === "manual"
                  ? "参考答案"
                  : part === "summary"
                    ? "答案"
                    : "正确答案"}
                ：
              </span>
              <strong>{expected.primary || "未提供"}</strong>
            </span>
          </>
        )}
        {row.weight > 1 && (
          <small>
            {result?.earned}/{row.weight}
          </small>
        )}
        <div className="exam-solution-actions">
          <button
            className="exam-small"
            aria-label={`${expanded ? "收起" : "查看"}${label}解析`}
            aria-expanded={expanded}
            aria-controls={`solution-${row.id}`}
            onClick={() => {
              setActive(row.id);
              setOpenSolutions((old) =>
                expanded ? old.filter((id) => id !== row.id) : [...old, row.id],
              );
            }}
          >
            {expanded ? "收起解析" : "解析"}
          </button>
          {(listening || canLocate) && (
            <button
              className="exam-small"
              disabled={!canLocate}
              title={
                !canLocate
                  ? "这道题没有可定位的本地录音"
                  : listening
                    ? "播放答案对应句，并定位右侧原文"
                    : "定位阅读原文依据"
              }
              aria-label={`${playing ? "暂停" : listening ? "播放" : "定位"}${label}${listening ? "录音" : "原文依据"}`}
              onClick={() => locate(row)}
            >
              {listening ? (
                playing ? (
                  <Pause size={14} />
                ) : (
                  <Play size={14} />
                )
              ) : (
                <Highlighter size={14} />
              )}
              {playing ? "暂停" : listening ? "播放" : "原文依据"}
            </button>
          )}
        </div>
      </div>
    );
    const details = expanded ? (
      <div className="exam-solution-body" id={`solution-${row.id}`}>
        <p>
          你的答案：
          <strong>
            {displayAnswer(row, answers[row.id] ?? "") || "未作答"}
          </strong>
        </p>
        {result?.reason && <p className="exam-unavailable">{result.reason}</p>}
        {expected.alternatives.length > 0 && (
          <p>其他可接受答案：{expected.alternatives.join(" / ")}</p>
        )}
        <RichText html={row.solution.explain || "此题未保存详细解析。"} />
        {row.solution.keywords && (
          <details>
            <summary>解题关键词</summary>
            <RichText html={row.solution.keywords} />
          </details>
        )}
        {answerQuotes(row.solution).map((quote, i) => (
          <blockquote key={i}>{quote}</blockquote>
        ))}
      </div>
    ) : null;
    if (part === "summary") return summary;
    if (part === "details") return details;
    return (
      <div className={`exam-solution ${status}`} data-review-for={row.id}>
        {summary}
        {details}
      </div>
    );
  }

  function choices(row: QuestionRow) {
    const multiple = row.type === "2";
    const result = grade?.results.find((r) => r.id === row.id);
    const selected = Array.isArray(answers[row.id])
      ? (answers[row.id] as string[])
      : [];
    return (
      <fieldset
        className="exam-choice-question"
        id={`question-${row.id}`}
        key={row.id}
        tabIndex={-1}
      >
        <legend>
          <span className="exam-number">
            {row.number}
            {row.endNumber > row.number ? `–${row.endNumber}` : ""}
          </span>
          <span>{textOf(row.content)}</span>
        </legend>
        {multiple && (
          <div className="exam-row-actions">
            <small>
              选择 {row.weight} 项 · 已选 {selected.length} 项
            </small>
          </div>
        )}
        {row.options.map((o) => {
          const checked = multiple
            ? selected.includes(o.value)
            : answers[row.id] === o.value;
          const expectedOption =
            result &&
            result.status !== "manual" &&
            (Array.isArray(row.expected) ? row.expected : [row.expected])
              .map(String)
              .includes(o.value);
          const wrongOption =
            result && result.status !== "manual" && checked && !expectedOption;
          return (
            <label
              className={`exam-choice ${checked ? "selected" : ""} ${expectedOption ? "exam-choice-correct" : wrongOption ? "exam-choice-incorrect" : ""}`}
              key={o.value}
            >
              <input
                type={multiple ? "checkbox" : "radio"}
                name={`${item.id}-${row.id}`}
                value={o.value}
                checked={checked}
                disabled={
                  submitted ||
                  (multiple && !checked && selected.length >= row.weight)
                }
                onChange={() =>
                  setAnswer(
                    row,
                    multiple
                      ? checked
                        ? selected.filter((v) => v !== o.value)
                        : [...selected, o.value]
                      : o.value,
                  )
                }
                onFocus={() => setActive(row.id)}
              />
              {row.type !== "3" && (
                <span className="exam-choice-letter">{o.label}</span>
              )}
              <span>
                <HtmlContent html={o.content} item={item} />
              </span>
              {(expectedOption || wrongOption) && (
                <span className="exam-choice-verdict">
                  {expectedOption
                    ? checked
                      ? "正确 · 已选"
                      : "正确答案"
                    : "误选"}
                </span>
              )}
            </label>
          );
        })}
        {!row.options.length && (
          <p className="exam-unavailable">
            本题选项结构不完整，请结合原始材料人工核对。
          </p>
        )}
        {solution(row)}
      </fieldset>
    );
  }

  function groupContent(group: QuestionGroup) {
    const slotRows = group.rows.flatMap((row) =>
      Array.from({ length: row.slots }, (_, slot) => ({ row, slot })),
    );
    const count = (
      String(group.content)
        .replace(/<[^>]*>/g, "")
        .match(/\.{6}/g) || []
    ).length;
    const inline =
      ["0", "4"].includes(group.type) && count === slotRows.length && count > 0;
    return (
      <section className="exam-question-group" key={group.id}>
        <header>
          <span>{group.title}</span>
          <strong>
            Questions {group.start}–{group.end}
          </strong>
        </header>
        <HtmlContent
          html={group.description}
          item={item}
          className="exam-instructions"
        />
        {group.optionsTitle && (
          <HtmlContent html={group.optionsTitle} item={item} />
        )}{" "}
        {group.type === "4" && (
          <div className="exam-option-bank">
            {group.rows[0]?.options.map((option) => (
              <div key={option.value}>
                <strong>{option.label}</strong>
                <HtmlContent html={option.content} item={item} />
              </div>
            ))}
          </div>
        )}
        {group.optionsImage && mediaUrl(item, group.optionsImage) && (
          <img
            className="exam-diagram"
            src={mediaUrl(item, group.optionsImage)}
            alt="匹配选项图"
          />
        )}
        {group.content && (
          <HtmlContent
            html={group.content}
            item={item}
            gap={
              inline
                ? (index) => {
                    const slot = slotRows[index];
                    const status = grade?.results.find(
                      (r) => r.id === slot?.row.id,
                    )?.status;
                    const completed =
                      slot && grade && status !== "manual"
                        ? completedBlankAnswer(slot.row)
                        : null;
                    if (slot && completed !== null)
                      return <CompletedBlank row={slot.row} value={completed} />;
                    return slot ? (
                      <InlineControl
                        row={slot.row}
                        slot={slot.slot}
                        answer={answers[slot.row.id]}
                        setAnswer={(v) => setAnswer(slot.row, v)}
                        disabled={submitted}
                        status={status}
                        focused={() => setActive(slot.row.id)}
                      />
                    ) : null;
                  }
                : undefined
            }
            gapFeedback={
              inline && grade
                ? (index) => {
                    const slot = slotRows[index];
                    return slot && slot.slot === slot.row.slots - 1
                      ? {
                          summary: solution(slot.row, "summary"),
                          details: solution(slot.row, "details"),
                        }
                      : null;
                  }
                : undefined
            }
          />
        )}
        {group.image &&
          !String(group.content).includes(group.image) &&
          mediaUrl(item, group.image) && (
            <img
              className="exam-diagram"
              src={mediaUrl(item, group.image)}
              alt="题目图示"
            />
          )}
        {["1", "2", "3"].includes(group.type) ? (
          group.rows.map(choices)
        ) : (
          <>
            {!inline && group.rows.length > 0 && (
              <p className="exam-hint">
                请参照上方题干与图示，在下方答题。
                {count > 0 && count !== slotRows.length
                  ? "原文空格与答案数量存在差异，请留意题号。"
                  : ""}
              </p>
            )}
            {!inline && (
              <div className="exam-answer-grid">
                {group.rows.map((row) => (
                  <div key={row.id} className="exam-answer-row">
                    <div className="exam-fallback-input">
                      {Array.from({ length: row.slots }, (_, i) => (
                        <InlineControl
                          key={i}
                          row={row}
                          slot={i}
                          answer={answers[row.id]}
                          disabled={submitted}
                          status={
                            grade?.results.find((r) => r.id === row.id)?.status
                          }
                          setAnswer={(v) => setAnswer(row, v)}
                          focused={() => setActive(row.id)}
                        />
                      ))}
                    </div>
                    {!row.supported && <small>人工核对</small>}
                    {solution(row)}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </section>
    );
  }

  const activeIndex = rows.findIndex((row) => row.id === active);
  const activeRow = rows[activeIndex];
  return (
    <PracticeFrame
      item={item}
      mode={submitted ? "review" : "practice"}
      onExit={onExit}
      onExam={onExam ? () => setModal("exam") : undefined}
      status={
        <div className="exam-session-status">
          {resultSummary && (
            <strong
              title={
                reviewing ? "本次历史记录保存的成绩" : "按本地标准答案核对"
              }
            >
              {resultSummary.score} / {resultSummary.total}
            </strong>
          )}
          <span className="exam-timer">
            <Clock3 size={17} />
            <span>{submitted ? "用时" : "已用时"}</span>
            <strong>{clock(elapsed)}</strong>
          </span>
          {!submitted && (
            <button
              onClick={() => setRunning((v) => !v)}
              aria-label={running ? "暂停计时" : "继续计时"}
              title={running ? "暂停计时" : "继续计时"}
            >
              {running ? <Pause size={16} /> : <Play size={16} />}
            </button>
          )}
          {!submitted && !running && <span>计时已暂停</span>}
        </div>
      }
      instruction={
        <div className="exam-session-instruction">
          <strong>
            Questions {rows[0]?.number ?? 0}–{rows.at(-1)?.endNumber ?? 0}
          </strong>
          <span>
            {submitted
              ? "Review the results beside each question."
              : "Answer all questions. Read the instructions for each question carefully."}
          </span>
          <small>
            {reviewing
              ? `${new Date(reviewAttempt!.createdAt).toLocaleString("zh-CN")} · 逐题解析对照当前本地标准答案`
              : submitted
                ? grade?.manual
                  ? `${grade.manual} 题需人工核对，当前得分不含这些题。`
                  : "结果已保存 · 单篇练习不换算 IELTS 总分"
                : `已作答 ${completed}/${rows.length} 组 · 草稿自动保存${elapsed > recommendedSeconds ? " · 已超过建议练习时间" : ""}`}
          </small>
        </div>
      }
      actions={
        submitted ? (
          <button onClick={() => setModal("reset")}>
            <RotateCcw size={16} />
            重新作答
          </button>
        ) : (
          <button className="ct-primary" onClick={() => setModal("submit")}>
            <Check size={16} />
            交卷检查
          </button>
        )
      }
      tools={
        listening ? (
          <div className="exam-audio-bar">
            <Volume2 size={21} />
            {src ? (
              <audio
                ref={audio}
                aria-label="听力录音"
                src={src}
                controls
                preload="metadata"
                onTimeUpdate={tickAudio}
                onPlay={() => {
                  setAudioPlaying(true);
                  setAudioError("");
                }}
                onPause={() => setAudioPlaying(false)}
                onLoadedMetadata={() => {
                  if (audio.current) {
                    setDuration(audio.current.duration);
                    audio.current.playbackRate = speed;
                  }
                }}
                onError={() =>
                  setAudioError(
                    "本地音频未能加载，请检查导入目录和文件是否存在。",
                  )
                }
                onEnded={() => {
                  setAudioPlaying(false);
                  if (playbackQuestion === null && loop && selectedLine !== null)
                    playLine(selectedLine, playbackQuestion);
                }}
              />
            ) : (
              <span className="exam-unavailable">
                这份材料没有可用的本地录音。
              </span>
            )}
            <label>
              倍速{" "}
              <select
                aria-label="播放速度"
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
              >
                {[0.5, 0.75, 1, 1.25, 1.5, 2].map((n) => (
                  <option key={n} value={n}>
                    {n}×
                  </option>
                ))}
              </select>
            </label>
            <button
              aria-expanded={transcriptOpen}
              aria-controls="exam-transcript-panel"
              className={transcriptOpen ? "selected" : ""}
              onClick={() => setTranscriptOpen((v) => !v)}
            >
              {transcriptOpen ? "收起原文" : "精听 · 原文"}
            </button>
          </div>
        ) : null
      }
      footer={
        <nav className="exam-question-nav" aria-label="题号导航">
          <span className="exam-nav-label">Questions</span>
          <div className="exam-number-list" ref={navigation}>
            {rows.map((row) => {
              const result = grade?.results.find((r) => r.id === row.id);
              const answer = answers[row.id];
              const filled = Array.isArray(answer)
                ? answer.some(Boolean)
                : !!answer;
              const label = `第 ${row.number}${row.endNumber > row.number ? `–${row.endNumber}` : ""} 题${result ? `，${statusText[result.status]}` : filled ? "，已作答" : "，未作答"}${flags.includes(row.id) ? "，已标记" : ""}`;
              return (
                <button
                  key={row.id}
                  className={`${active === row.id ? "active" : ""} ${filled ? "answered" : ""} ${flags.includes(row.id) ? "flagged" : ""} ${result?.status || ""}`}
                  onClick={() => go(row.id)}
                  aria-label={label}
                  title={label}
                  aria-current={active === row.id ? "step" : undefined}
                >
                  {row.number}
                  {row.endNumber > row.number ? `–${row.endNumber}` : ""}
                  {flags.includes(row.id) && <i />}
                </button>
              );
            })}
          </div>
          <div className="exam-nav-actions">
            {!submitted && activeRow && (
              <button
                aria-pressed={flags.includes(active)}
                title={`标记第 ${activeRow.number} 题；共 ${flags.length} 组待检查`}
                className={flags.includes(active) ? "flagged" : ""}
                onClick={() => toggleFlag(active)}
              >
                <Flag size={16} />
                <span>Review</span>
              </button>
            )}
            <button
              aria-label="上一题"
              disabled={activeIndex <= 0}
              onClick={() => go(rows[activeIndex - 1].id)}
            >
              <ChevronLeft size={21} />
            </button>
            <button
              aria-label="下一题"
              disabled={activeIndex < 0 || activeIndex >= rows.length - 1}
              onClick={() => go(rows[activeIndex + 1].id)}
            >
              <ChevronRight size={21} />
            </button>
          </div>
        </nav>
      }
    >
      <div
        className={`exam-workspace ${listening ? "exam-listening" : "exam-reading"} ${submitted ? "exam-review" : ""}`}
      >
        {reviewing && !reviewAttempt?.answers && (
          <p className="exam-unavailable" role="status">
            这条历史记录只有汇总成绩，没有保存逐题答案。
          </p>
        )}
        {audioError && (
          <p className="exam-unavailable" role="status">
            {audioError}
          </p>
        )}
        <div className="exam-columns" ref={panes}>
          {!listening && (
            <section
              className="exam-passage-panel"
              ref={passagePanel}
              aria-label="Reading text"
              tabIndex={0}
              style={{ flexBasis: `${split}%` }}
            >
              <div className="exam-panel-heading">
                <strong>阅读原文</strong>
                <div>
                  <button
                    className={passageTranslation ? "selected" : ""}
                    disabled={!data.articleTranslation}
                    onClick={() => {
                      setPassageTranslation((v) => !v);
                      setFocusQuotes([]);
                    }}
                  >
                    {passageTranslation ? "显示英文" : "中文译文"}
                  </button>
                  <span title="选择原文文字后保存标注">
                    <Highlighter size={16} />
                  </span>
                </div>
              </div>
              <div className="exam-selection-bar">
                {selection ? (
                  <>
                    <span>已选 {selection.text.length} 字</span>
                    <button onClick={addHighlight}>
                      <Highlighter size={14} />
                      保存标注
                    </button>
                    <button
                      aria-label="取消选择"
                      onClick={() => setSelection(null)}
                    >
                      <X size={14} />
                    </button>
                  </>
                ) : (
                  <span>
                    {reviewing
                      ? "历史复盘仅查看；重新作答后可保存新标注。"
                      : "选择英文原文，可保存高亮标注。"}
                  </span>
                )}
                {focusQuotes.length > 0 && (
                  <button onClick={() => setFocusQuotes([])}>
                    清除答案定位
                  </button>
                )}
              </div>
              <div
                ref={passage}
                tabIndex={0}
                aria-label={passageTranslation ? "阅读译文" : "阅读原文"}
                className="exam-passage"
                onMouseUp={captureSelection}
                onKeyUp={(event) => {
                  if (event.shiftKey) captureSelection();
                }}
                onTouchEnd={() => setTimeout(captureSelection, 100)}
              >
                <HtmlContent
                  html={
                    passageTranslation
                      ? data.articleTranslation
                      : data.passagesContent
                  }
                  item={item}
                  highlights={
                    passageTranslation
                      ? []
                      : [...highlights, ...locatedHighlights]
                  }
                />
              </div>
              {highlights.length > 0 && (
                <details className="exam-annotations">
                  <summary>
                    <Bookmark size={14} />
                    已保存 {highlights.length} 条标注
                  </summary>
                  {highlights.map((h) => (
                    <div key={h.id}>
                      <span>{h.text}</span>
                      <button
                        aria-label="删除这条标注"
                        disabled={reviewing}
                        onClick={() =>
                          setHighlights((old) =>
                            old.filter((x) => x.id !== h.id),
                          )
                        }
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </details>
              )}
            </section>
          )}
          {!listening && (
            <div
              className="exam-divider"
              role="separator"
              aria-label="调整阅读原文与题目宽度"
              aria-orientation="vertical"
              aria-valuemin={30}
              aria-valuemax={70}
              aria-valuenow={Math.round(split)}
              aria-valuetext={`原文 ${Math.round(split)}%，题目 ${100 - Math.round(split)}%`}
              title="拖动或按左右方向键调整；Enter 恢复等宽"
              tabIndex={0}
              onPointerDown={changeSplit}
              onDoubleClick={() => setSplit(50)}
              onKeyDown={(event) => {
                const next = splitByKeyboard(split, event.key);
                if (next !== null) {
                  event.preventDefault();
                  setSplit(next);
                }
              }}
            />
          )}
          <section
            className="exam-questions-panel"
            ref={questionsPanel}
            aria-label="Questions"
            tabIndex={0}
          >
            <div className="exam-panel-heading">
              <strong>答题区</strong>
              <span>认真阅读每组字数与选项要求</span>
            </div>
            {groups.length ? (
              groups.map(groupContent)
            ) : (
              <p className="exam-unavailable">
                这份材料未包含可识别的题组。请重新导入原始资料。
              </p>
            )}
          </section>
          {listening && transcriptOpen && (
            <section
              id="exam-transcript-panel"
              className="exam-transcript-panel"
              ref={transcriptPanel}
              aria-label="Listening transcript"
              tabIndex={0}
            >
              <div className="exam-panel-heading">
                <strong>逐句精听</strong>
                <button onClick={() => setTranslation((v) => !v)}>
                  {translation ? "隐藏译文" : "显示译文"}
                </button>
              </div>
              <div className="exam-loop-tools">
                <button
                  disabled={selectedLine === null || selectedLine <= 0}
                  onClick={() => playLine((selectedLine ?? 0) - 1)}
                  aria-label="上一句"
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  disabled={
                    selectedLine === null || selectedLine >= lines.length - 1
                  }
                  onClick={() => playLine((selectedLine ?? -1) + 1)}
                  aria-label="下一句"
                >
                  <ChevronRight size={16} />
                </button>
                <label>
                  <input
                    type="checkbox"
                    checked={loop}
                    onChange={(e) => {
                      setLoop(e.target.checked);
                      if (e.target.checked && selectedLine === null)
                        setSelectedLine(Math.max(currentLine, 0));
                    }}
                  />{" "}
                  单句循环
                </label>
                <small>
                  {selectedLine !== null
                    ? `精听第 ${selectedLine + 1} 句 · 文字可拖选`
                    : "文字可拖选，点 ▶ 开始精听"}
                </small>
              </div>
              <div className="exam-transcript">
                {lines.length ? (
                  lines.map((line, i) => (
                    <div
                      id={`line-${i}`}
                      key={i}
                      className={`exam-transcript-line ${currentLine === i ? "playing" : ""} ${selectedLine === i ? "focused" : ""} ${transcriptTarget?.index === i ? "located" : ""}`}
                    >
                      <button
                        type="button"
                        className="exam-line-play"
                        disabled={!src}
                        aria-label={`${audioPlaying && currentLine === i ? "暂停" : "播放"}第 ${i + 1} 句（${clock(line.start)}）`}
                        title={
                          audioPlaying && currentLine === i
                            ? "暂停播放"
                            : `从 ${clock(line.start)} 开始播放`
                        }
                        onClick={() => {
                          if (audioPlaying && currentLine === i)
                            audio.current?.pause();
                          else playLine(i);
                        }}
                      >
                        {audioPlaying && currentLine === i ? (
                          <Pause size={14} aria-hidden="true" />
                        ) : (
                          <Play size={14} aria-hidden="true" />
                        )}
                        <span className="exam-line-time">
                          {clock(line.start)}
                        </span>
                      </button>
                      <span className="exam-transcript-text">
                        {transcriptTarget?.index === i && (
                          <span className="exam-transcript-target">
                            第 {transcriptTarget.number} 题依据
                          </span>
                        )}
                        {line.text}
                        {translation && line.translation && (
                          <small>{line.translation}</small>
                        )}
                      </span>
                    </div>
                  ))
                ) : (
                  <HtmlContent
                    html={data.listenContent || "这份资料没有逐句时间轴。"}
                    item={item}
                  />
                )}
              </div>
            </section>
          )}
        </div>

        <dialog
          ref={dialog}
          className="exam-dialog"
          aria-labelledby="exam-dialog-title"
          aria-describedby="exam-dialog-description"
          onCancel={(event) => {
            event.preventDefault();
            setModal(null);
          }}
          onClose={() => setModal(null)}
        >
          <h2 id="exam-dialog-title">
            {modal === "submit"
              ? "提交这次练习？"
              : modal === "reset"
                ? "开始新一轮练习？"
                : "进入考试设置？"}
          </h2>
          <p id="exam-dialog-description">
            {modal === "submit"
              ? `已完成 ${completed}/${rows.length} 组答案，${flags.length} 组标记待检查。提交后显示答案与解析，并保存学习记录。`
              : modal === "reset"
                ? reviewing
                  ? "历史成绩和原文标注保留；开始新一轮后将替换这份材料的当前草稿。"
                  : "历史成绩和原文标注保留，本次答案与计时将清空。"
                : "当前练习草稿会保留。进入考试设置后，可查看考试规则并开始或继续考试。"}
          </p>
          <div>
            <button autoFocus onClick={() => setModal(null)}>
              继续查看
            </button>
            <button
              className="ct-primary"
              onClick={() => {
                if (modal === "submit") submit();
                else if (modal === "reset") reset();
                else {
                  if (!reviewing) saveDraft(item.id, draft.current);
                  audio.current?.pause();
                  setModal(null);
                  onExam?.();
                }
              }}
            >
              {modal === "submit"
                ? "确认交卷"
                : modal === "reset"
                  ? "开始练习"
                  : "进入考试设置"}
            </button>
          </div>
        </dialog>
      </div>
    </PracticeFrame>
  );
}
