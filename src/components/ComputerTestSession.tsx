import {
  createElement,
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type MouseEvent,
} from "react";
import DOMPurify from "dompurify";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Flag,
  Highlighter,
  Menu,
  Maximize,
  NotebookPen,
  Volume2,
  X,
} from "lucide-react";
import type { StudyItem } from "../types";
import { mediaUrl, textOf } from "../lib/content";
import {
  getProgress,
  recordAttempt,
  saveDraftIfCurrent,
  useSaveError,
} from "../lib/progress";
import {
  buildGroups,
  gradeGroups,
  type QuestionGroup,
  type QuestionRow,
} from "../lib/questions.mjs";
import {
  answeredQuestion,
  elapsedSeconds,
  examDraftKey,
  optionFromDrop,
  questionNavigation,
  remainingSeconds,
  validSession,
  sessionSignature,
  prepareSessionSave,
  type QuestionNav,
} from "../lib/computer-test.mjs";
import "../computer-test.css";

type Answers = Record<string, string | string[]>;
type Mark = { id: string; start: number; end: number; text: string };
type Selection = {
  surface: string;
  start: number;
  end: number;
  text: string;
  x: number;
  y: number;
  markId?: string;
};
type Session = {
  version: 1;
  revision?: number;
  runId?: string;
  phase: "active" | "submission" | "complete";
  answers: Answers;
  marked: number[];
  highlights: Record<string, Mark[]>;
  notes: string;
  startedAt: number;
  deadline: number | null;
  audioPosition: number;
  audioEnded: boolean;
  completedAt?: number;
  attemptId?: string;
};
type Screen = "setup" | "active" | "submission" | "complete";
type Modal = "options" | "contrast" | "text" | "exit" | null;
const safeHTML = (html: unknown) =>
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
function time(seconds: number) {
  const n = Math.max(0, Math.floor(seconds));
  return `${Math.floor(n / 60)
    .toString()
    .padStart(2, "0")}:${(n % 60).toString().padStart(2, "0")}`;
}
function withoutControls(fragment: DocumentFragment) {
  fragment
    .querySelectorAll("[data-ct-control],select,input,button")
    .forEach((node) => node.remove());
  return fragment.textContent || "";
}

function Content({
  html,
  item,
  gap,
  marks = [],
  surface,
  onSelection,
  className = "",
}: {
  html: unknown;
  item: StudyItem;
  gap?: (index: number) => ReactNode;
  marks?: Mark[];
  surface: string;
  onSelection?: (selection: Selection | null) => void;
  className?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const body = useMemo(() => {
    const el = document.createElement("div");
    el.innerHTML = safeHTML(html);
    return el;
  }, [html]);
  let offset = 0,
    gapIndex = 0,
    keyIndex = 0;
  function renderText(value: string, key: number): ReactNode {
    const start = offset;
    offset += value.length;
    const matching = marks.filter(
      (mark) => mark.start < offset && mark.end > start,
    );
    if (!matching.length) return value;
    const edges = [
      ...new Set([
        0,
        value.length,
        ...matching.flatMap((mark) => [
          Math.max(0, mark.start - start),
          Math.min(value.length, mark.end - start),
        ]),
      ]),
    ].sort((a, b) => a - b);
    return (
      <Fragment key={key}>
        {edges.slice(0, -1).map((a, i) => {
          const b = edges[i + 1],
            mark = matching.find(
              (m) => m.start <= start + a && m.end >= start + b,
            );
          return mark ? (
            <mark key={a} data-ct-mark={mark.id}>
              {value.slice(a, b)}
            </mark>
          ) : (
            value.slice(a, b)
          );
        })}
      </Fragment>
    );
  }
  function render(node: Node): ReactNode {
    const key = keyIndex++;
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent || "";
      if (gap && value.includes("......"))
        return (
          <Fragment key={key}>
            {value.split(/(\.{6})/).map((part, i) => (
              <Fragment key={i}>
                {part === "......"
                  ? gap(gapIndex++)
                  : renderText(part, keyIndex++)}
              </Fragment>
            ))}
          </Fragment>
        );
      return renderText(value, key);
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const el = node as HTMLElement,
      tag = el.tagName.toLowerCase(),
      props: Record<string, unknown> = { key };
    if (tag === "img") {
      const src = mediaUrl(item, el.getAttribute("src") || "");
      if (!src)
        return (
          <span key={key} className="ct-missing">
            [Image unavailable in this archive]
          </span>
        );
      props.src = src;
      props.alt = el.getAttribute("alt") || "Question illustration";
      props.loading = "lazy";
    }
    for (const [name, reactName] of [
      ["colspan", "colSpan"],
      ["rowspan", "rowSpan"],
    ]) {
      const value = el.getAttribute(name);
      if (value) props[reactName] = Number(value);
    }
    if (["br", "hr", "img", "wbr", "col"].includes(tag))
      return createElement(tag, props);
    return createElement(tag, props, ...Array.from(el.childNodes).map(render));
  }
  function select(event: MouseEvent<HTMLDivElement>, context = false) {
    if (!onSelection || !container.current) return;
    const selected = window.getSelection();
    if (selected?.rangeCount && !selected.isCollapsed) {
      const range = selected.getRangeAt(0);
      if (container.current.contains(range.commonAncestorContainer)) {
        const text = withoutControls(range.cloneContents());
        if (text.trim() && text.length <= 5000) {
          if (context) event.preventDefault();
          const before = range.cloneRange();
          before.selectNodeContents(container.current);
          before.setEnd(range.startContainer, range.startOffset);
          const start = withoutControls(before.cloneContents());
          const bounds = range.getBoundingClientRect();
          onSelection({
            surface,
            start: start.length,
            end: start.length + text.length,
            text,
            x: Math.min(bounds.left, window.innerWidth - 255),
            y: Math.min(bounds.bottom + 8, window.innerHeight - 110),
          });
          return;
        }
      }
    }
    const markElement = (event.target as HTMLElement).closest("[data-ct-mark]");
    const marked = marks.find(
      (mark) => mark.id === markElement?.getAttribute("data-ct-mark"),
    );
    if (marked) {
      if (context) event.preventDefault();
      onSelection({
        ...marked,
        surface,
        markId: marked.id,
        x: Math.min(event.clientX, window.innerWidth - 255),
        y: Math.min(event.clientY + 8, window.innerHeight - 110),
      });
    }
  }
  return (
    <div
      className={`ct-rich ${className}`}
      ref={container}
      onMouseUp={(event) => select(event)}
      onContextMenu={(event) => select(event, true)}
    >
      {Array.from(body.childNodes).map(render)}
    </div>
  );
}

function newSession(): Session {
  return {
    version: 1,
    runId: crypto.randomUUID(),
    phase: "active",
    answers: {},
    marked: [],
    highlights: {},
    notes: "",
    startedAt: Date.now(),
    deadline: null,
    audioPosition: 0,
    audioEnded: false,
  };
}
export default function ComputerTestSession({
  item,
  onExit,
}: {
  item: StudyItem;
  onExit: () => void;
}) {
  return <SessionView key={item.id} item={item} onExit={onExit} />;
}
function SessionView({
  item,
  onExit,
}: {
  item: StudyItem;
  onExit: () => void;
}) {
  const data = item.data?.data?.questions ? item.data.data : item.data || {};
  const listening = item.kind === "listening";
  const groups = useMemo(() => buildGroups(data), [data]);
  const rows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
  const navigation = useMemo(() => questionNavigation(groups), [groups]);
  const rowMap = useMemo(
    () => new Map(rows.map((row) => [row.id, row])),
    [rows],
  );
  const draftKey = examDraftKey(item.id);
  const [previous, setPrevious] = useState<Session | null>(() => {
    const value = getProgress().drafts[draftKey];
    return validSession(value) ? value : null;
  });
  const [session, setSession] = useState<Session>(previous || newSession());
  const [screen, setScreen] = useState<Screen>("setup");
  const [now, setNow] = useState(Date.now());
  const [timed, setTimed] = useState(false);
  const [minutes, setMinutes] = useState(
    listening
      ? Math.max(1, Math.ceil(((Number(data.seconds) || 480) + 120) / 60))
      : 20,
  );
  const [activeNumber, setActiveNumber] = useState(navigation[0]?.number || 1);
  const [modal, setModal] = useState<Modal>(null);
  const [contrast, setContrast] = useState("black-white");
  const [textSize, setTextSize] = useState("regular");
  const [notesOpen, setNotesOpen] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioError, setAudioError] = useState("");
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [volume, setVolume] = useState(1);
  const [split, setSplit] = useState(50);
  const [fullscreenError, setFullscreenError] = useState("");
  const [conflicted, setConflicted] = useState(false),
    [submitting, setSubmitting] = useState(false);
  const conflictRef = useRef(false),
    expectedSave = useRef(sessionSignature(getProgress().drafts[draftKey]));
  const pendingWrites = useRef<Promise<boolean>>(Promise.resolve(true));
  const root = useRef<HTMLDivElement>(null),
    audio = useRef<HTMLAudioElement>(null),
    panes = useRef<HTMLDivElement>(null),
    dialog = useRef<HTMLDivElement>(null);
  const sessionRef = useRef(session),
    screenRef = useRef(screen),
    audioPosition = useRef(session.audioPosition || 0),
    submitted = useRef(false);
  sessionRef.current = session;
  screenRef.current = screen;
  const saveError = useSaveError();
  const src = mediaUrl(item, data.audioUrl);
  const part = Number(data.part) || 1;
  const first = navigation[0]?.number || 1,
    last = navigation.at(-1)?.number || first;
  const remaining = remainingSeconds(session.deadline, now);
  const answered = navigation.filter((nav) =>
    answeredQuestion(nav, rowMap.get(nav.rowId)!, session.answers),
  ).length;
  const grade = useMemo(
    () => gradeGroups(groups, session.answers),
    [groups, session.answers],
  );

  function update(patch: Partial<Session>) {
    if (conflictRef.current || sessionRef.current.phase === "complete") return;
    setSession((current) => ({ ...current, ...patch }));
  }
  function snapshot() {
    return { ...sessionRef.current, audioPosition: audioPosition.current };
  }
  function conflict() {
    conflictRef.current = true;
    setConflicted(true);
    audio.current?.pause();
    setSelection(null);
    setModal(null);
  }
  async function lock<T>(operation: () => T | Promise<T>): Promise<T> {
    return navigator.locks
      ? navigator.locks.request(`ielts-lab-${draftKey}`, operation)
      : operation();
  }
  function saveChecked(proposed: Session) {
    if (conflictRef.current) return false;
    const next = prepareSessionSave(
      getProgress().drafts[draftKey],
      expectedSave.current,
      proposed,
    );
    if (!next || !saveDraftIfCurrent(draftKey, next, expectedSave.current)) {
      conflict();
      return false;
    }
    expectedSave.current = sessionSignature(next);
    return true;
  }
  function persist(proposed: Session) {
    if (submitted.current && proposed.phase !== "complete")
      return pendingWrites.current;
    pendingWrites.current = pendingWrites.current
      .catch(() => false)
      .then(() => lock(() => saveChecked(proposed)));
    return pendingWrites.current;
  }

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (screen === "active" || screen === "submission")
      void persist(snapshot());
  }, [draftKey, session, screen]);
  useEffect(() => {
    const flush = () => {
      if (screenRef.current === "active" || screenRef.current === "submission")
        void persist(snapshot());
    };
    const id = setInterval(flush, 5000);
    window.addEventListener("pagehide", flush);
    return () => {
      clearInterval(id);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [draftKey]);
  useEffect(() => {
    if (
      (screen === "active" ||
        screen === "submission" ||
        (screen === "setup" && previous && previous.phase !== "complete")) &&
      remaining === 0 &&
      session.deadline !== null
    )
      finish(true);
  }, [remaining, screen, session.deadline, previous]);
  useEffect(() => {
    if (audio.current) audio.current.volume = volume;
  }, [volume]);
  useEffect(() => {
    if (modal) {
      setSelection(null);
      requestAnimationFrame(() =>
        dialog.current?.querySelector<HTMLButtonElement>("button")?.focus(),
      );
    }
  }, [modal]);
  useEffect(() => {
    if (!modal) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setModal(null);
        return;
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const nodes = Array.from(
        dialog.current.querySelectorAll<HTMLElement>(
          "button:not(:disabled),input,select,textarea,a[href]",
        ),
      );
      const index = nodes.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && index <= 0) {
        event.preventDefault();
        nodes.at(-1)?.focus();
      } else if (!event.shiftKey && index === nodes.length - 1) {
        event.preventDefault();
        nodes[0]?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [modal]);
  useEffect(() => {
    const element = root.current,
      player = audio.current;
    return () => {
      player?.pause();
      if (document.fullscreenElement === element)
        document.exitFullscreen().catch(() => {});
    };
  }, []);

  async function fullscreen() {
    if (!root.current) return;
    try {
      await root.current.requestFullscreen();
      setFullscreenError("");
    } catch {
      setFullscreenError(
        "Full screen is unavailable. You can still practise in this window.",
      );
    }
  }
  function start(resume: boolean) {
    if (conflictRef.current) return;
    const stored = getProgress().drafts[draftKey];
    if (sessionSignature(stored) !== expectedSave.current) {
      conflict();
      return;
    }
    let next: Session;
    if (resume && validSession(stored) && stored.phase !== "complete") {
      next = {
        ...stored,
        phase: "active",
        marked: stored.marked || [],
        highlights: stored.highlights || {},
        notes: stored.notes || "",
      };
    } else if (resume) {
      setPrevious(validSession(stored) ? stored : null);
      return;
    } else {
      next = {
        ...newSession(),
        deadline: timed
          ? Date.now() + Math.max(1, Math.min(180, minutes)) * 60000
          : null,
      };
    }
    submitted.current = false;
    audioPosition.current = next.audioPosition;
    sessionRef.current = next;
    setSession(next);
    setNow(Date.now());
    setScreen("active");
    setModal(null);
    setSelection(null);
    setAudioError("");
    void persist(next);
    if (
      listening &&
      src &&
      !next.audioEnded &&
      (next.deadline === null || next.deadline > Date.now())
    )
      playAudio(next.audioPosition);
  }
  function playAudio(position = audioPosition.current) {
    const player = audio.current;
    if (!player) return;
    player.currentTime = position;
    player.playbackRate = 1;
    player.volume = volume;
    player
      .play()
      .then(() => {
        setAudioBlocked(false);
        setAudioError("");
      })
      .catch(() => {
        setAudioBlocked(true);
        setAudioError(
          "Audio could not start. Select Resume audio to continue from the saved position.",
        );
      });
  }
  async function finish(automatic = false) {
    if (
      submitted.current ||
      conflictRef.current ||
      sessionRef.current.phase === "complete"
    )
      return;
    submitted.current = true;
    setSubmitting(true);
    audio.current?.pause();
    const current = snapshot(),
      completedAt = Date.now();
    const result = gradeGroups(groups, current.answers);
    const work = pendingWrites.current
      .catch(() => false)
      .then(() =>
        lock(() => {
          const checkpoint: Session = {
            ...current,
            phase: "complete",
            completedAt,
          };
          if (!saveChecked(checkpoint)) return false;
          recordAttempt({
            itemId: item.id,
            title: item.title,
            kind: item.kind,
            answers: current.answers,
            score: result.score,
            total: result.total,
            durationSeconds: elapsedSeconds(
              current.startedAt,
              completedAt,
              current.deadline,
            ),
            detail: `Computer familiarisation · single part · ${current.deadline ? "timed" : "untimed"}${automatic ? " · time limit reached" : ""}${result.manual ? ` · ${result.manual} require manual review` : ""}`,
          });
          const attempt = getProgress().attempts[0];
          const next: Session = {
            ...checkpoint,
            attemptId: attempt?.itemId === item.id ? attempt.id : undefined,
          };
          if (!saveChecked(next)) return false;
          sessionRef.current = next;
          setSession(next);
          setPrevious(next);
          setScreen("complete");
          setModal(null);
          setSelection(null);
          return true;
        }),
      );
    pendingWrites.current = work;
    await work;
    setSubmitting(false);
  }
  async function exit() {
    if (screen === "active" || screen === "submission")
      await persist(snapshot());
    audio.current?.pause();
    onExit();
  }
  function go(number: number | undefined) {
    if (
      number === undefined ||
      conflictRef.current ||
      sessionRef.current.phase === "complete" ||
      submitting
    )
      return;
    const target = navigation.find((nav) => nav.number === number);
    if (!target) return;
    setActiveNumber(number);
    setSelection(null);
    if (screen === "submission") {
      setScreen("active");
      update({ phase: "active" });
    }
    requestAnimationFrame(() => {
      const element = document.getElementById(`ct-question-${target.rowId}`);
      element?.scrollIntoView({ block: "center" });
      const control = element?.matches("input,select")
        ? element
        : element?.querySelector<HTMLElement>(
            "input:not(:disabled),select,button",
          );
      (control as HTMLElement | undefined)?.focus({ preventScroll: true });
    });
  }
  function focusRow(row: QuestionRow) {
    setActiveNumber((current) =>
      current >= row.number && current <= row.endNumber ? current : row.number,
    );
  }
  function answer(row: QuestionRow, value: string | string[]) {
    if (
      screen !== "active" ||
      conflictRef.current ||
      submitting ||
      (sessionRef.current.deadline !== null &&
        remainingSeconds(sessionRef.current.deadline) === 0)
    ) {
      if (
        sessionRef.current.deadline !== null &&
        remainingSeconds(sessionRef.current.deadline) === 0
      )
        void finish(true);
      return;
    }
    setSession((current) => ({
      ...current,
      answers: { ...current.answers, [row.id]: value },
    }));
    focusRow(row);
  }
  function markQuestion(number: number) {
    if (screen !== "active" || conflictRef.current || submitting) return;
    setSession((current) => ({
      ...current,
      marked: current.marked.includes(number)
        ? current.marked.filter((value) => value !== number)
        : [...current.marked, number],
    }));
  }
  function selectText(value: Selection | null) {
    if (screen === "active" && !conflictRef.current && !submitting)
      setSelection(value);
  }
  function highlight() {
    if (!selection) return;
    const value = selection;
    setSession((current) => ({
      ...current,
      highlights: {
        ...current.highlights,
        [value.surface]: [
          ...(current.highlights[value.surface] || []),
          {
            id: crypto.randomUUID(),
            start: value.start,
            end: value.end,
            text: value.text,
          },
        ],
      },
    }));
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }
  function clearHighlight() {
    if (!selection) return;
    const value = selection;
    setSession((current) => ({
      ...current,
      highlights: {
        ...current.highlights,
        [value.surface]: (current.highlights[value.surface] || []).filter(
          (mark) =>
            value.markId
              ? mark.id !== value.markId
              : mark.end <= value.start || mark.start >= value.end,
        ),
      },
    }));
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }
  function noteSelection() {
    if (selection)
      update({
        notes: `${session.notes}${session.notes ? "\n\n" : ""}${selection.text}\n`,
      });
    setNotesOpen(true);
    setSelection(null);
  }
  function renderContent(
    html: unknown,
    surface: string,
    gap?: (index: number) => ReactNode,
    className = "",
  ) {
    return (
      <Content
        html={html}
        item={item}
        surface={surface}
        marks={session.highlights[surface] || []}
        gap={gap}
        onSelection={selectText}
        className={className}
      />
    );
  }
  function control(row: QuestionRow, groupId: string, slot = 0) {
    const id = slot === 0 ? `ct-question-${row.id}` : undefined;
    const value =
      row.slots > 1
        ? Array.isArray(session.answers[row.id])
          ? (session.answers[row.id] as string[])[slot] || ""
          : ""
        : String(session.answers[row.id] || "");
    const placeholder = `${row.number}${row.slots > 1 ? String.fromCharCode(97 + slot) : ""}`;
    return row.type === "4" ? (
      <span
        data-ct-control
        className="ct-match-target"
        id={id}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(event) => {
          event.preventDefault();
          const dropped = optionFromDrop(
            event.dataTransfer.getData("application/x-ielts-option"),
            groupId,
            row.options,
          );
          if (dropped !== null) answer(row, dropped);
        }}
      >
        <select
          disabled={submitting}
          aria-label={`Question ${row.number} answer`}
          value={String(session.answers[row.id] || "")}
          onChange={(event) => answer(row, event.target.value)}
          onFocus={() => focusRow(row)}
        >
          <option value="">{placeholder}</option>
          {row.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label} — {textOf(option.content)}
            </option>
          ))}
        </select>
      </span>
    ) : (
      <span data-ct-control className="ct-fill-target">
        <input
          id={id}
          className="ct-gap"
          autoComplete="off"
          spellCheck={false}
          disabled={submitting}
          aria-label={`Question ${row.number}${row.slots > 1 ? ` blank ${slot + 1}` : ""}`}
          placeholder={placeholder}
          value={value}
          onFocus={() => focusRow(row)}
          onChange={(event) => {
            if (row.slots > 1) {
              const values = Array.isArray(session.answers[row.id])
                ? [...(session.answers[row.id] as string[])]
                : Array(row.slots).fill("");
              values[slot] = event.target.value;
              answer(row, values);
            } else answer(row, event.target.value);
          }}
        />
      </span>
    );
  }
  function choices(row: QuestionRow) {
    const multiple = row.type === "2";
    const selected = Array.isArray(session.answers[row.id])
      ? (session.answers[row.id] as string[])
      : [];
    return (
      <fieldset
        className="ct-choice-question"
        key={row.id}
        id={`ct-question-${row.id}`}
      >
        <legend>
          <strong>
            {row.number}
            {row.endNumber > row.number ? `–${row.endNumber}` : ""}
          </strong>{" "}
          {textOf(row.content)}
        </legend>
        {row.options.map((option) => {
          const checked = multiple
            ? selected.includes(option.value)
            : session.answers[row.id] === option.value;
          return (
            <label key={option.value}>
              <input
                type={multiple ? "checkbox" : "radio"}
                name={`ct-${row.id}`}
                value={option.value}
                checked={checked}
                disabled={
                  submitting ||
                  (multiple && !checked && selected.length >= row.weight)
                }
                onFocus={() => focusRow(row)}
                onChange={() =>
                  answer(
                    row,
                    multiple
                      ? checked
                        ? selected.filter((v) => v !== option.value)
                        : [...selected, option.value]
                      : option.value,
                  )
                }
              />
              {row.type !== "3" && <strong>{option.label}</strong>}
              {renderContent(
                option.content,
                `option-${row.id}-${option.value}`,
              )}
            </label>
          );
        })}
      </fieldset>
    );
  }
  function groupView(group: QuestionGroup) {
    const slots = group.rows.flatMap((row) =>
      Array.from({ length: row.slots }, (_, slot) => ({ row, slot })),
    );
    const actual = (
      String(group.content)
        .replace(/<[^>]*>/g, "")
        .match(/\.{6}/g) || []
    ).length;
    const inline =
      ["0", "4"].includes(group.type) && actual === slots.length && actual > 0;
    return (
      <section className="ct-question-group" key={group.id}>
        <h2>
          Questions {group.start}
          {group.end > group.start ? `–${group.end}` : ""}
        </h2>
        {renderContent(group.description, `instructions-${group.id}`)}
        {group.optionsTitle &&
          renderContent(group.optionsTitle, `options-title-${group.id}`)}
        {group.type === "4" && (
          <div className="ct-option-bank">
            {group.rows[0]?.options.map((option) => (
              <div
                key={option.value}
                className="ct-draggable-option"
                draggable
                title="Drag to a gap. You can also use the gap's dropdown."
                onDragStart={(event) => {
                  event.dataTransfer.setData(
                    "application/x-ielts-option",
                    JSON.stringify({ groupId: group.id, value: option.value }),
                  );
                  event.dataTransfer.effectAllowed = "copy";
                }}
              >
                <strong>{option.label}</strong>
                {renderContent(
                  option.content,
                  `matching-option-${group.id}-${option.value}`,
                )}
              </div>
            ))}
          </div>
        )}
        {group.optionsImage && mediaUrl(item, group.optionsImage) && (
          <img
            className="ct-diagram"
            src={mediaUrl(item, group.optionsImage)}
            alt="Matching options"
          />
        )}
        {group.content &&
          renderContent(
            group.content,
            `content-${group.id}`,
            inline
              ? (index) => {
                  const value = slots[index];
                  return value
                    ? control(value.row, group.id, value.slot)
                    : null;
                }
              : undefined,
          )}
        {group.image &&
          !String(group.content).includes(group.image) &&
          mediaUrl(item, group.image) && (
            <img
              className="ct-diagram"
              src={mediaUrl(item, group.image)}
              alt="Question illustration"
            />
          )}
        {["1", "2", "3"].includes(group.type) ? (
          group.rows.map(choices)
        ) : !inline ? (
          <>
            <p className="ct-compatibility">
              Use the question text above to complete the numbered answer boxes
              below.
              {actual > 0
                ? " The source layout does not map exactly to the answer boxes."
                : ""}
            </p>
            <div className="ct-fallback-answers">
              {slots.map(({ row, slot }) => (
                <label key={`${row.id}-${slot}`}>
                  Question {row.number}
                  {control(row, group.id, slot)}
                </label>
              ))}
            </div>
          </>
        ) : null}
      </section>
    );
  }
  function submission() {
    if (
      sessionRef.current.phase === "complete" ||
      conflictRef.current ||
      submitting
    )
      return;
    setSelection(null);
    setModal(null);
    setScreen("submission");
    update({ phase: "submission" });
  }
  function changeSplit(event: React.PointerEvent<HTMLDivElement>) {
    const bounds = panes.current?.getBoundingClientRect();
    if (!bounds) return;
    event.currentTarget.setPointerCapture(event.pointerId);
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
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  return (
    <div
      ref={root}
      className={`computer-test ct-contrast-${contrast} ct-size-${textSize}`}
    >
      <audio
        ref={audio}
        src={src || undefined}
        preload="metadata"
        onPlaying={() => {
          setAudioPlaying(true);
          setAudioBlocked(false);
        }}
        onPause={() => setAudioPlaying(false)}
        onTimeUpdate={() => {
          if (audio.current) audioPosition.current = audio.current.currentTime;
        }}
        onEnded={() => {
          setAudioPlaying(false);
          update({ audioEnded: true });
        }}
        onError={() => {
          setAudioPlaying(false);
          if (screenRef.current !== "setup")
            setAudioError(
              "The local audio file could not be loaded. Check the archive and resume audio.",
            );
        }}
      />
      {screen === "setup" ? (
        <div className="ct-setup">
          <div className="ct-own-brand">IELTS Lab</div>
          <main>
            <p className="ct-setup-label">COMPUTER FAMILIARISATION</p>
            <h1>Single-part practice</h1>
            <p className="ct-setup-title">{item.title}</p>
            <p>
              Practise the computer-test controls using your own local material.
              This session contains one{" "}
              {listening ? "listening part" : "reading passage"}, not a complete
              IELTS test.
            </p>
            <fieldset className="ct-time-choice">
              <legend>Practice time</legend>
              <label>
                <input
                  type="radio"
                  name="ct-time"
                  checked={!timed}
                  onChange={() => setTimed(false)}
                />{" "}
                Untimed familiarisation
              </label>
              <label>
                <input
                  type="radio"
                  name="ct-time"
                  checked={timed}
                  onChange={() => setTimed(true)}
                />{" "}
                Timed practice{" "}
                <input
                  aria-label="Practice time in minutes"
                  type="number"
                  min={1}
                  max={180}
                  value={minutes}
                  onChange={(event) =>
                    setMinutes(
                      Math.max(
                        1,
                        Math.min(180, Number(event.target.value) || 1),
                      ),
                    )
                  }
                  disabled={!timed}
                />{" "}
                minutes
              </label>
              <small>
                The time limit is your practice setting. The timer continues if
                you leave this page.
              </small>
            </fieldset>
            {listening && (
              <p>
                Audio plays once after you start. During the session you can
                change the volume, but cannot pause, seek or change playback
                speed.
              </p>
            )}
            {!src && listening && (
              <p className="ct-error">
                This item does not have a local audio file.
              </p>
            )}
            {previous && previous.phase !== "complete" && (
              <div className="ct-resume">
                <strong>A saved practice is available.</strong>
                <p>
                  {Object.keys(previous.answers || {}).length} answer groups
                  saved.{" "}
                  {previous.deadline
                    ? "Its timed deadline is retained."
                    : "This practice is untimed."}
                </p>
                <button className="ct-primary" onClick={() => start(true)}>
                  Resume practice
                </button>
              </div>
            )}
            {previous?.phase === "complete" && (
              <p className="ct-resume">
                Your last result is saved.{" "}
                <button
                  onClick={() => {
                    setSession(previous);
                    setScreen("complete");
                    submitted.current = true;
                  }}
                >
                  View last result
                </button>
              </p>
            )}
            <div className="ct-setup-actions">
              <button onClick={onExit}>Back to library</button>
              <button onClick={fullscreen}>
                <Maximize size={17} /> Full screen
              </button>
              <button
                className="ct-primary"
                disabled={!rows.length}
                onClick={() => start(false)}
              >
                {previous
                  ? "Start new practice"
                  : listening
                    ? "Play audio and start"
                    : "Start practice"}
              </button>
            </div>
            {fullscreenError && <p role="status">{fullscreenError}</p>}
            <p className="ct-independent">
              Independent practice software. The IELTS Lab interface is not
              provided by IDP or an IELTS test centre.
            </p>
          </main>
        </div>
      ) : (
        <>
          <header className="ct-header">
            <div className="ct-own-brand">IELTS Lab</div>
            <div className="ct-test-taker">
              <strong>Test taker ID</strong>
              <span>
                {listening ? (
                  <>
                    <Volume2 size={16} />
                    {session.audioEnded
                      ? "Audio has finished"
                      : audioPlaying
                        ? "Audio is Playing"
                        : screen === "complete"
                          ? "Practice completed"
                          : "Audio is not playing"}
                  </>
                ) : screen === "complete" ? (
                  "Practice completed"
                ) : (
                  "Reading"
                )}
              </span>
            </div>
            <div className="ct-header-tools">
              {session.deadline !== null && screen !== "complete" && (
                <span
                  className={`ct-countdown ${remaining !== null && remaining <= 60 ? "ct-time-low" : ""}`}
                  aria-label="Time remaining"
                >
                  {time(remaining || 0)}
                </span>
              )}
              {listening && screen !== "complete" && (
                <label className="ct-volume">
                  <Volume2 size={17} />
                  <input
                    aria-label="Audio volume"
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={volume}
                    onChange={(event) => setVolume(Number(event.target.value))}
                  />
                </label>
              )}
              <button
                title="Options"
                aria-label="Options"
                onClick={() => setModal("options")}
              >
                <Menu size={25} />
              </button>
              <button
                title={notesOpen ? "Hide notes" : "Show notes"}
                aria-label={notesOpen ? "Hide notes" : "Show notes"}
                className={notesOpen ? "ct-pressed" : ""}
                onClick={() => {
                  setNotesOpen((value) => !value);
                  setSelection(null);
                }}
              >
                <NotebookPen size={25} />
              </button>
            </div>
          </header>
          {(audioError || saveError) && (
            <div className="ct-live-message" role="status">
              {audioError ||
                "Your latest work is held in this browser. The local save service is temporarily unavailable."}
              {audioBlocked && screen !== "complete" && (
                <button onClick={() => playAudio()}>Resume audio</button>
              )}
            </div>
          )}
          {screen === "active" ? (
            <>
              <div className="ct-workarea">
                <div className="ct-exam-content">
                  <div className="ct-instruction">
                    <strong>Part {part}</strong>
                    <p>
                      {listening ? "Listen" : "Read the passage"} and answer
                      questions {first}–{last}.
                    </p>
                  </div>
                  <div
                    className={`ct-panes ${listening ? "ct-listening" : "ct-reading"}`}
                    ref={panes}
                  >
                    {!listening && (
                      <>
                        <div
                          className="ct-reading-passage"
                          style={{ flexBasis: `${split}%` }}
                        >
                          {renderContent(
                            data.passagesContent,
                            "reading-passage",
                          )}
                        </div>
                        <div
                          className="ct-divider"
                          role="separator"
                          aria-label="Resize reading panes"
                          aria-orientation="vertical"
                          aria-valuemin={30}
                          aria-valuemax={70}
                          aria-valuenow={split}
                          tabIndex={0}
                          onPointerDown={changeSplit}
                          onKeyDown={(event) => {
                            if (
                              event.key === "ArrowLeft" ||
                              event.key === "ArrowRight"
                            ) {
                              event.preventDefault();
                              setSplit((value) =>
                                Math.max(
                                  30,
                                  Math.min(
                                    70,
                                    value +
                                      (event.key === "ArrowLeft" ? -2 : 2),
                                  ),
                                ),
                              );
                            }
                          }}
                        />
                      </>
                    )}
                    <div className="ct-questions">
                      {groups.map(groupView)}
                      <div className="ct-review-marker">
                        <label>
                          <input
                            type="checkbox"
                            checked={session.marked.includes(activeNumber)}
                            onChange={() => markQuestion(activeNumber)}
                          />{" "}
                          Mark question {activeNumber} for review
                        </label>
                      </div>
                    </div>
                  </div>
                </div>
                {notesOpen && (
                  <aside className="ct-notes">
                    <div>
                      <strong>Notes</strong>
                      <button
                        aria-label="Hide notes"
                        onClick={() => setNotesOpen(false)}
                      >
                        <X size={20} />
                      </button>
                    </div>
                    <textarea
                      aria-label="Notes"
                      placeholder="Write your notes here..."
                      value={session.notes}
                      onChange={(event) =>
                        update({ notes: event.target.value })
                      }
                    />
                  </aside>
                )}
              </div>
              <div className="ct-step-controls">
                <button
                  aria-label="Previous question"
                  disabled={activeNumber === first}
                  onClick={() => {
                    const index = navigation.findIndex(
                      (nav) => nav.number === activeNumber,
                    );
                    go(navigation[index - 1]?.number);
                  }}
                >
                  <ArrowLeft size={27} />
                </button>
                <button
                  aria-label="Next question"
                  disabled={activeNumber === last}
                  onClick={() => {
                    const index = navigation.findIndex(
                      (nav) => nav.number === activeNumber,
                    );
                    go(navigation[index + 1]?.number);
                  }}
                >
                  <ArrowRight size={27} />
                </button>
              </div>
            </>
          ) : screen === "submission" ? (
            <main className="ct-submission">
              <h1>Review your answers</h1>
              <p>
                You have answered {answered} of {navigation.length} questions.
              </p>
              <p>
                Check your answers before you submit. You can return to any
                question below.
              </p>
              <h2>Part {part}</h2>
              <div className="ct-review-grid">
                {navigation.map((nav) => (
                  <button
                    key={nav.number}
                    className={`${answeredQuestion(nav, rowMap.get(nav.rowId)!, session.answers) ? "ct-is-answered" : ""} ${session.marked.includes(nav.number) ? "ct-marked" : ""}`}
                    onClick={() => go(nav.number)}
                  >
                    <strong>{nav.number}</strong>
                    <span>
                      {answeredQuestion(
                        nav,
                        rowMap.get(nav.rowId)!,
                        session.answers,
                      )
                        ? "Answered"
                        : "Not answered"}
                    </span>
                    {session.marked.includes(nav.number) && <Flag size={15} />}
                  </button>
                ))}
              </div>
              <div className="ct-submission-actions">
                <button
                  onClick={() => {
                    setScreen("active");
                    update({ phase: "active" });
                  }}
                >
                  Return to questions
                </button>
                <button
                  className="ct-primary"
                  onClick={() => void finish(false)}
                  disabled={submitting}
                >
                  {submitting ? "Saving answers…" : "Submit answers"}
                </button>
              </div>
            </main>
          ) : (
            <main className="ct-complete">
              <h1>Practice submitted</h1>
              <p>Your answers have been saved to your learning history.</p>
              <div className="ct-score">
                <strong>{grade.score}</strong>
                <span> / {grade.total}</span>
              </div>
              <p>
                Time used:{" "}
                {time(
                  elapsedSeconds(
                    session.startedAt,
                    session.completedAt || now,
                    session.deadline,
                  ),
                )}
              </p>
              {grade.manual > 0 && (
                <p>
                  {grade.manual} question(s) require manual review and are not
                  included in your earned score.
                </p>
              )}
              <p>This single-part practice score is not an IELTS band score.</p>
              <div className="ct-submission-actions">
                <button onClick={exit}>Back to library</button>
                {session.attemptId && (
                  <a
                    className="ct-primary"
                    href={`#/item/${encodeURIComponent(item.id)}?review=${encodeURIComponent(session.attemptId)}`}
                  >
                    Review answers and explanations
                  </a>
                )}
                <button
                  onClick={() => {
                    const stored = getProgress().drafts[draftKey];
                    setPrevious(validSession(stored) ? stored : null);
                    setScreen("setup");
                    setAudioError("");
                  }}
                >
                  Practise again
                </button>
              </div>
            </main>
          )}
          {screen !== "complete" && (
            <footer className="ct-footer">
              <div className="ct-part">
                <strong>Part {part}</strong>
                <div className="ct-question-numbers">
                  {navigation.map((nav) => (
                    <button
                      key={nav.number}
                      className={`${activeNumber === nav.number && screen === "active" ? "ct-active" : ""} ${answeredQuestion(nav, rowMap.get(nav.rowId)!, session.answers) ? "ct-is-answered" : ""} ${session.marked.includes(nav.number) ? "ct-marked" : ""}`}
                      aria-label={`Question ${nav.number}${session.marked.includes(nav.number) ? ", marked for review" : ""}`}
                      onClick={() => go(nav.number)}
                    >
                      <span className="ct-question-progress" />
                      {nav.number}
                      {session.marked.includes(nav.number) && <i />}
                    </button>
                  ))}
                </div>
              </div>
              <span className="ct-answer-count">
                {answered} of {navigation.length}
              </span>
              <button
                className="ct-review-submit"
                aria-label="Review your answers"
                title="Review your answers"
                onClick={submission}
              >
                <Check size={25} />
              </button>
            </footer>
          )}
        </>
      )}
      {selection && !modal && screen === "active" && (
        <div
          className="ct-text-menu"
          style={{
            left: Math.max(8, selection.x),
            top: Math.max(75, selection.y),
          }}
          onMouseDown={(event) => event.preventDefault()}
        >
          <button onClick={highlight}>
            <Highlighter size={15} /> Highlight
          </button>
          <button onClick={noteSelection}>
            <NotebookPen size={15} /> Note
          </button>
          <button onClick={clearHighlight}>Clear highlight</button>
          <button
            aria-label="Close selection menu"
            onClick={() => setSelection(null)}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {conflicted && (
        <div
          className="ct-conflict-screen"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="ct-conflict-title"
        >
          <div>
            <h1 id="ct-conflict-title">
              This practice changed in another window
            </h1>
            <p>
              Saving and audio have stopped so this window cannot replace the
              newer answers. Reload to use the latest saved practice.
            </p>
            <button
              className="ct-primary"
              onClick={() => window.location.reload()}
            >
              Reload saved practice
            </button>
            <button onClick={onExit}>Back to library</button>
          </div>
        </div>
      )}
      {modal && !conflicted && (
        <div
          className="ct-options-screen"
          ref={dialog}
          role="dialog"
          aria-modal="true"
          aria-labelledby="ct-options-heading"
        >
          <button
            className="ct-options-back"
            aria-label="Back"
            onClick={() =>
              setModal(
                modal === "contrast" || modal === "text" ? "options" : null,
              )
            }
          >
            <ArrowLeft size={25} />
          </button>
          <button
            className="ct-options-close"
            aria-label="Close options"
            onClick={() => setModal(null)}
          >
            <X size={27} />
          </button>
          <div className="ct-options-center">
            <h1 id="ct-options-heading">
              {modal === "options"
                ? "Options"
                : modal === "contrast"
                  ? "Contrast"
                  : modal === "text"
                    ? "Text size"
                    : "Leave this practice?"}
            </h1>
            {modal === "options" ? (
              <div className="ct-option-choices">
                {session.phase !== "complete" && (
                  <button onClick={submission}>Go to submission page</button>
                )}
                <button onClick={() => setModal("contrast")}>Contrast</button>
                <button onClick={() => setModal("text")}>Text size</button>
                <button onClick={() => setModal("exit")}>Exit practice</button>
              </div>
            ) : modal === "contrast" ? (
              <div className="ct-option-choices">
                {[
                  ["black-white", "Black on white"],
                  ["white-black", "White on black"],
                  ["yellow-black", "Yellow on black"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    className={contrast === value ? "ct-selected" : ""}
                    onClick={() => setContrast(value)}
                  >
                    {label}
                    {contrast === value && <Check size={18} />}
                  </button>
                ))}
              </div>
            ) : modal === "text" ? (
              <div className="ct-option-choices">
                {[
                  ["regular", "Regular"],
                  ["large", "Large"],
                  ["extra", "Extra large"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    className={textSize === value ? "ct-selected" : ""}
                    onClick={() => setTextSize(value)}
                  >
                    {label}
                    {textSize === value && <Check size={18} />}
                  </button>
                ))}
              </div>
            ) : (
              <>
                <p>
                  Your answers will be saved. A timed practice keeps its
                  original deadline when you return.
                </p>
                <div className="ct-option-choices">
                  <button onClick={() => setModal(null)}>
                    Continue practice
                  </button>
                  <button onClick={exit}>Save and exit</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
