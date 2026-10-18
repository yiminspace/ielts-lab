import {
  createElement,
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
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
import "../exam.css";

type Answers = Record<string, string | string[]>;
type Highlight = { id: string; start: number; end: number; text: string };
type Draft = {
  answers: Answers;
  flags: string[];
  highlights: Highlight[];
  elapsed: number;
  submitted: boolean;
};
const statusText: Record<string, string> = {
  correct: "正确",
  incorrect: "未答对",
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
  highlights = [],
  className = "",
}: {
  html: unknown;
  item: StudyItem;
  gap?: (index: number) => ReactNode;
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
    return createElement(
      tag,
      props,
      ...Array.from(node.childNodes).map(render),
    );
  }
  return (
    <div className={`exam-rich ${className}`}>
      {Array.from(root.childNodes).map(render)}
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
}: {
  row: QuestionRow;
  slot?: number;
  answer: string | string[] | undefined;
  setAnswer: (value: string | string[]) => void;
  disabled: boolean;
  focused?: () => void;
}) {
  const current =
    row.slots > 1
      ? Array.isArray(answer)
        ? answer[slot] || ""
        : ""
      : String(answer || "");
  return (
    <span
      className="exam-inline-answer"
      id={slot === 0 ? `question-${row.id}` : undefined}
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
    </span>
  );
}

export default function ExamWorkspace({
  item,
  reviewAttempt,
}: {
  item: StudyItem;
  reviewAttempt?: Attempt;
}) {
  return (
    <ExamSession
      key={`${item.id}:${reviewAttempt?.id || "draft"}`}
      item={item}
      reviewAttempt={reviewAttempt}
    />
  );
}

function ExamSession({
  item,
  reviewAttempt,
}: {
  item: StudyItem;
  reviewAttempt?: Attempt;
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
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [active, setActive] = useState(rows[0]?.id || "");
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [translation, setTranslation] = useState(false);
  const [passageTranslation, setPassageTranslation] = useState(false);
  const [selection, setSelection] = useState<Omit<Highlight, "id"> | null>(
    null,
  );
  const [focusQuotes, setFocusQuotes] = useState<string[]>([]);
  const [audioTime, setAudioTime] = useState(0);
  const [duration, setDuration] = useState(Number(data.seconds) || 0);
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(false);
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const [audioError, setAudioError] = useState("");
  const audio = useRef<HTMLAudioElement>(null);
  const passage = useRef<HTMLDivElement>(null);
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
  useEffect(() => {
    if (focusQuotes.length)
      passage.current
        ?.querySelector("mark")
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusQuotes]);

  function setAnswer(row: QuestionRow, value: string | string[]) {
    if (submitted) return;
    setAnswers((old) => ({ ...old, [row.id]: value }));
    setActive(row.id);
  }
  function toggleFlag(id: string) {
    if (reviewing) return;
    setFlags((old) =>
      old.includes(id) ? old.filter((x) => x !== id) : [...old, id],
    );
  }
  function go(id: string) {
    setActive(id);
    document
      .getElementById(`question-${id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  function playLine(index: number) {
    const line = lines[index];
    if (!line || !audio.current) return;
    setSelectedLine(index);
    audio.current.currentTime = line.start;
    audio.current
      .play()
      .catch(() => setAudioError("播放未能启动，请点击音频控件重试。"));
  }
  function tickAudio() {
    const player = audio.current;
    if (!player) return;
    if (
      loop &&
      selectedLine !== null &&
      lines[selectedLine] &&
      player.currentTime >= lines[selectedLine].end - 0.05
    )
      player.currentTime = lines[selectedLine].start;
    setAudioTime(player.currentTime);
  }
  function submit() {
    if (reviewing) return;
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
    setRunning(false);
    setConfirmSubmit(false);
    audio.current?.pause();
  }
  function reset() {
    setReviewing(false);
    setAnswers({});
    setFlags([]);
    setElapsed(0);
    setSubmitted(false);
    setRunning(true);
    setConfirmReset(false);
    setFocusQuotes([]);
    setActive(rows[0]?.id || "");
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
    if (listening) {
      setTranscriptOpen(true);
      const n = Number(row.solution.sentenceList?.[0]);
      let index = Number.isFinite(n) && n > 0 ? n - 1 : -1;
      const phrase = String(row.solution.positionSentence || "")
        .split(/[;；\n]/)
        .find((x) => x.trim());
      if (phrase) {
        const matching = lines.findIndex((line) =>
          line.text.toLowerCase().includes(phrase.trim().toLowerCase()),
        );
        if (matching >= 0) index = matching;
      }
      if (index >= 0 && index < lines.length) {
        playLine(index);
        setTimeout(
          () =>
            document
              .getElementById(`line-${index}`)
              ?.scrollIntoView({ behavior: "smooth", block: "center" }),
          50,
        );
      }
    } else {
      setPassageTranslation(false);
      setFocusQuotes(answerQuotes(row.solution));
    }
  }
  function solution(row: QuestionRow) {
    if (!grade) return null;
    const result = grade.results.find((r) => r.id === row.id);
    return (
      <details className={`exam-solution ${result?.status}`}>
        <summary>
          <span className="exam-status">
            {statusText[result?.status || "manual"]}
          </span>
          <span>
            第 {row.number}
            {row.endNumber > row.number ? `–${row.endNumber}` : ""} 题 · 答案：
            {displayAnswer(row)}
          </span>
          {row.weight > 1 && (
            <small>
              {result?.earned}/{row.weight}
            </small>
          )}
        </summary>
        <div className="exam-solution-body">
          <p>
            你的答案：
            <strong>
              {displayAnswer(row, answers[row.id] ?? "") || "未作答"}
            </strong>
          </p>
          {result?.reason && (
            <p className="exam-unavailable">{result.reason}</p>
          )}
          {(
            listening
              ? row.solution.sentenceList?.length ||
                row.solution.positionSentence
              : answerQuotes(row.solution).length > 0
          ) ? (
            <button className="exam-small" onClick={() => locate(row)}>
              <Volume2 size={15} />{" "}
              {listening ? "定位录音与原文" : "定位原文依据"}
            </button>
          ) : null}
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
      </details>
    );
  }

  function choices(row: QuestionRow) {
    const multiple = row.type === "2";
    const selected = Array.isArray(answers[row.id])
      ? (answers[row.id] as string[])
      : [];
    return (
      <fieldset
        className="exam-choice-question"
        id={`question-${row.id}`}
        key={row.id}
      >
        <legend>
          <span className="exam-number">
            {row.number}
            {row.endNumber > row.number ? `–${row.endNumber}` : ""}
          </span>
          <span>{textOf(row.content)}</span>
        </legend>
        <div className="exam-row-actions">
          <button
            className={flags.includes(row.id) ? "flagged" : ""}
            disabled={reviewing}
            onClick={() => toggleFlag(row.id)}
            aria-label={`标记第 ${row.number} 题`}
          >
            <Flag size={14} />
            {flags.includes(row.id) ? "已标记" : "待检查"}
          </button>
          {multiple && (
            <small>
              选择 {row.weight} 项 · 已选 {selected.length} 项
            </small>
          )}
        </div>
        {row.options.map((o) => {
          const checked = multiple
            ? selected.includes(o.value)
            : answers[row.id] === o.value;
          return (
            <label
              className={`exam-choice ${checked ? "selected" : ""}`}
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
                    return slot ? (
                      <InlineControl
                        row={slot.row}
                        slot={slot.slot}
                        answer={answers[slot.row.id]}
                        setAnswer={(v) => setAnswer(slot.row, v)}
                        disabled={submitted}
                        focused={() => setActive(slot.row.id)}
                      />
                    ) : null;
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
            <div className={inline ? "exam-blank-actions" : "exam-answer-grid"}>
              {group.rows.map((row) => (
                <div key={row.id} className="exam-answer-row">
                  {!inline && (
                    <div className="exam-fallback-input">
                      {Array.from({ length: row.slots }, (_, i) => (
                        <InlineControl
                          key={i}
                          row={row}
                          slot={i}
                          answer={answers[row.id]}
                          disabled={submitted}
                          setAnswer={(v) => setAnswer(row, v)}
                        />
                      ))}
                    </div>
                  )}
                  <button
                    className={flags.includes(row.id) ? "flagged" : ""}
                    disabled={reviewing}
                    onClick={() => toggleFlag(row.id)}
                    aria-label={`标记第 ${row.number} 题`}
                  >
                    <Flag size={13} />
                    {row.number}
                  </button>
                  {!row.supported && <small>人工核对</small>}
                </div>
              ))}
            </div>
            {grade &&
              group.rows.map((row) => (
                <Fragment key={row.id}>{solution(row)}</Fragment>
              ))}
          </>
        )}
      </section>
    );
  }

  return (
    <div
      className={`exam-workspace ${listening ? "exam-listening" : "exam-reading"}`}
    >
      <div className="exam-toolbar">
        <div>
          <span className="exam-mode">
            {listening ? "LISTENING" : "READING"} PRACTICE
          </span>
          <h2>{item.title}</h2>
        </div>
        <div className="exam-timer">
          <Clock3 size={17} />
          <strong>{clock(elapsed)}</strong>
          <button
            onClick={() => setRunning((v) => !v)}
            disabled={submitted}
            aria-label={running ? "暂停计时" : "继续计时"}
          >
            {running ? <Pause size={15} /> : <Play size={15} />}
          </button>
        </div>
        <div className="exam-toolbar-actions">
          {submitted ? (
            <button
              className="exam-primary"
              onClick={() => setConfirmReset(true)}
            >
              <RotateCcw size={16} />
              {reviewing ? "重新作答" : "重新练习"}
            </button>
          ) : (
            <button
              className="exam-primary"
              onClick={() => setConfirmSubmit(true)}
            >
              <Check size={16} />
              交卷检查
            </button>
          )}
        </div>
      </div>
      <div className="exam-subbar">
        <span>
          {reviewing
            ? `历史复盘 · ${new Date(reviewAttempt!.createdAt).toLocaleString("zh-CN")}`
            : submitted
              ? "本次练习已完成，结果已保存"
              : "练习模式 · 草稿自动保存"}
          {!submitted && elapsed > recommendedSeconds
            ? " · 已超过建议练习时间"
            : ""}
        </span>
        <span>
          已作答 {completed}/{rows.length} 组 · 共 {fullCount} 分值
        </span>
      </div>
      {resultSummary && (
        <section className="exam-result-banner">
          <div>
            <small>{reviewing ? "历史成绩" : "本次练习"}</small>
            <strong>
              {resultSummary.score}
              <span> / {resultSummary.total}</span>
            </strong>
          </div>
          <p>
            用时 {clock(elapsed)} ·{" "}
            {resultSummary.total
              ? Math.round((resultSummary.score / resultSummary.total) * 100)
              : 0}
            % 正确率
            <br />
            <span>
              {reviewing
                ? "展示本次保存的答案，逐题解析对照当前本地标准答案。"
                : grade?.manual
                  ? `${grade.manual} 题需要人工核对，当前得分不含这些题。`
                  : "查看下方解析，定位原文并复习错题。"}{" "}
              单篇练习不换算 IELTS 总分。
            </span>
          </p>
        </section>
      )}
      {reviewing && !reviewAttempt?.answers && (
        <p className="exam-unavailable">
          这条历史记录只有汇总成绩，没有保存逐题答案。
        </p>
      )}
      {listening && (
        <div className="exam-audio-bar">
          <Volume2 size={21} />
          {src ? (
            <audio
              ref={audio}
              src={src}
              controls
              preload="metadata"
              onTimeUpdate={tickAudio}
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
                if (loop && selectedLine !== null) playLine(selectedLine);
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
            className={transcriptOpen ? "selected" : ""}
            onClick={() => setTranscriptOpen((v) => !v)}
          >
            {transcriptOpen ? "收起原文" : "精听 · 原文"}
          </button>
        </div>
      )}
      {audioError && (
        <p className="exam-unavailable" role="status">
          {audioError}
        </p>
      )}
      <div className="exam-columns">
        {!listening && (
          <section className="exam-passage-panel">
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
                <button onClick={() => setFocusQuotes([])}>清除答案定位</button>
              )}
            </div>
            <div
              ref={passage}
              className="exam-passage"
              onMouseUp={captureSelection}
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
                        setHighlights((old) => old.filter((x) => x.id !== h.id))
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
        <section className="exam-questions-panel">
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
          <section className="exam-transcript-panel">
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
                  ? `选中第 ${selectedLine + 1} 句`
                  : "点击一句开始播放"}
              </small>
            </div>
            <div className="exam-transcript">
              {lines.length ? (
                lines.map((line, i) => (
                  <button
                    id={`line-${i}`}
                    key={i}
                    className={`exam-transcript-line ${currentLine === i ? "playing" : ""} ${selectedLine === i ? "focused" : ""}`}
                    onClick={() => playLine(i)}
                  >
                    <span className="exam-line-time">{clock(line.start)}</span>
                    <span>
                      {line.text}
                      {translation && line.translation && (
                        <small>{line.translation}</small>
                      )}
                    </span>
                  </button>
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
      <nav className="exam-question-nav" aria-label="题号导航">
        <span>题号</span>
        <div>
          {rows.map((row) => {
            const result = grade?.results.find((r) => r.id === row.id);
            const answer = answers[row.id];
            const filled = Array.isArray(answer)
              ? answer.some(Boolean)
              : !!answer;
            return (
              <button
                key={row.id}
                className={`${active === row.id ? "active" : ""} ${filled ? "answered" : ""} ${flags.includes(row.id) ? "flagged" : ""} ${result?.status || ""}`}
                onClick={() => go(row.id)}
                aria-label={`跳转第 ${row.number} 题${flags.includes(row.id) ? "，已标记" : ""}`}
              >
                {row.number}
                {row.endNumber > row.number ? `–${row.endNumber}` : ""}
                {flags.includes(row.id) && <i />}
              </button>
            );
          })}
        </div>
        <small>
          <Flag size={13} />
          {flags.length} 待检查
        </small>
      </nav>
      {(confirmSubmit || confirmReset) && (
        <div className="exam-dialog-backdrop">
          <div
            className="exam-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="exam-dialog-title"
          >
            <h3 id="exam-dialog-title">
              {confirmSubmit ? "提交这次练习？" : "开始新一轮练习？"}
            </h3>
            <p>
              {confirmSubmit
                ? `已完成 ${completed}/${rows.length} 组答案，${flags.length} 组标记待检查。提交后显示答案与解析，并保存学习记录。`
                : reviewing
                  ? "历史成绩和原文标注保留；开始新一轮后将替换这份材料的当前草稿。"
                  : "历史成绩和原文标注保留，本次答案与计时将清空。"}
            </p>
            <div>
              <button
                onClick={() => {
                  setConfirmSubmit(false);
                  setConfirmReset(false);
                }}
              >
                继续查看
              </button>
              <button
                className="exam-primary"
                onClick={confirmSubmit ? submit : reset}
              >
                {confirmSubmit ? "确认交卷" : "开始练习"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
