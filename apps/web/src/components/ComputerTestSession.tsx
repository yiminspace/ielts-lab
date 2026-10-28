import { ieltsExamAttrs } from "../lib/exam-theme";
import { DailyAttemptBanner } from "./DailyWorkspace";
import {
  createElement,
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type MouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
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
  questionNavigationEntries,
  navigationEntryProgress,
  navigationEntryMarked,
  toggleNavigationEntryMark,
  matchingMatrix,
  remainingSeconds,
  validSession,
  sessionSignature,
  prepareSessionSave,
  paperParts,
  answersForPart,
  paperDraftKey,
  paperReadingDeadline,
  advancePaperAudio,
  validatePaperParts,
  navigationDestination,
  scrollQuestionWithinPane,
  splitByKeyboard,
  type QuestionNavEntry,
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
  keyboard?: boolean;
  returnFocus?: HTMLElement;
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
  attemptIds?: string[];
  finishReason?: "submitted" | "timeout";
  audioIndex?: number;
  viewedPart?: number;
};
type Screen = "setup" | "active" | "submission" | "complete";
type Modal = "options" | "contrast" | "text" | "help" | "exit" | null;
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
  textOffset = 0,
}: {
  html: unknown;
  item: StudyItem;
  gap?: (index: number) => ReactNode;
  marks?: Mark[];
  surface: string;
  onSelection?: (selection: Selection | null) => void;
  className?: string;
  textOffset?: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const body = useMemo(() => {
    const el = document.createElement("div");
    el.innerHTML = safeHTML(html);
    return el;
  }, [html]);
  let offset = textOffset,
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
  function select(
    event: MouseEvent<HTMLDivElement> | ReactKeyboardEvent<HTMLDivElement>,
    context = false,
    keyboard = false,
  ) {
    if (
      !onSelection ||
      !container.current ||
      (event.target as HTMLElement).closest(
        "input,select,textarea,[data-ct-control]",
      )
    )
      return;
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
            start: textOffset + start.length,
            end: textOffset + start.length + text.length,
            text,
            keyboard,
            returnFocus:
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : container.current,
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
        keyboard,
        returnFocus:
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : container.current,
        x: Math.min(
          "clientX" in event
            ? event.clientX
            : markElement!.getBoundingClientRect().left,
          window.innerWidth - 255,
        ),
        y: Math.min(
          ("clientY" in event
            ? event.clientY
            : markElement!.getBoundingClientRect().bottom) + 8,
          window.innerHeight - 110,
        ),
      });
    }
  }
  return (
    <div
      className={`ct-rich ${className}`}
      ref={container}
      onMouseUp={(event) => select(event)}
      onContextMenu={(event) => select(event, true)}
      onKeyUp={(event) => {
        if (
          event.shiftKey &&
          [
            "ArrowLeft",
            "ArrowRight",
            "ArrowUp",
            "ArrowDown",
            "Home",
            "End",
          ].includes(event.key)
        )
          select(event);
      }}
      onKeyDown={(event) => {
        if (
          event.key === "ContextMenu" ||
          (event.shiftKey && event.key === "F10")
        )
          select(event, true, true);
      }}
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
export interface PaperMode {
  paperId: string;
  runId: string;
  startedAt: number;
  items: StudyItem[];
  shortDemo?: boolean;
  autoStart?: boolean;
  onComplete: (result: {
    attemptIds: string[];
    finishedAt: number;
    reason: "submitted" | "timeout";
  }) => void;
}
type SessionProps = {
  item: StudyItem;
  onExit: () => void;
  paperMode?: PaperMode;
};
export default function ComputerTestSession(props: SessionProps) {
  return (
    <SessionView
      key={
        props.paperMode
          ? `${props.paperMode.paperId}:${props.paperMode.runId}:${props.item.kind}`
          : props.item.id
      }
      {...props}
    />
  );
}
function SessionView({ item: initialItem, onExit, paperMode }: SessionProps) {
  const paperItems = useMemo(
    () => paperMode?.items || [initialItem],
    [paperMode?.items, initialItem],
  );
  const normalizedParts = useMemo(
    () => (paperMode ? paperParts(paperItems) : []),
    [paperMode, paperItems],
  );
  const draftKey = paperMode
    ? paperDraftKey(paperMode.paperId, paperMode.runId, initialItem.kind)
    : examDraftKey(initialItem.id);
  const [previous, setPrevious] = useState<Session | null>(() => {
    const value = getProgress().drafts[draftKey];
    return validSession(value) ? value : null;
  });
  const [viewedPart, setViewedPart] = useState(
    Math.min(paperItems.length - 1, Math.max(0, previous?.viewedPart || 0)),
  );
  const item = paperItems[viewedPart] || initialItem;
  const data = item.data?.data?.questions ? item.data.data : item.data || {};
  const listening = initialItem.kind === "listening";
  const trackLabel =
    item.testTrack === "general"
      ? "General Training"
      : item.testTrack === "academic"
        ? "Academic"
        : item.testTrack === "shared"
          ? "Academic & General Training"
          : "Track unclassified";
  const singleGroups = useMemo(() => buildGroups(data), [data]);
  const groups = useMemo(
    () =>
      paperMode ? normalizedParts.flatMap((part) => part.groups) : singleGroups,
    [paperMode, normalizedParts, singleGroups],
  );
  const visibleGroups = paperMode
    ? normalizedParts[viewedPart]?.groups || []
    : groups;
  const rows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
  const navigation = useMemo(() => questionNavigation(groups), [groups]);
  const navigationEntries = useMemo(
    () => questionNavigationEntries(groups),
    [groups],
  );
  const rowMap = useMemo(
    () => new Map(rows.map((row) => [row.id, row])),
    [rows],
  );
  const paperError = paperMode
    ? (!Number.isFinite(paperMode.startedAt)
        ? "This paper has no valid start time."
        : "") ||
      validatePaperParts(
        paperItems,
        normalizedParts,
        initialItem.kind,
        paperMode.shortDemo,
      ) ||
      (listening &&
      paperItems.some(
        (part) =>
          !mediaUrl(
            part,
            (part.data?.data?.questions ? part.data.data : part.data)?.audioUrl,
          ),
      )
        ? "One or more listening parts have no local audio file. This paper cannot start."
        : "")
    : "";
  const [session, setSession] = useState<Session>(previous || newSession());
  const [screen, setScreen] = useState<Screen>("setup");
  const [now, setNow] = useState(Date.now());
  const [timed, setTimed] = useState(false);
  const [minutes, setMinutes] = useState(
    listening
      ? Math.max(1, Math.ceil(((Number(data.seconds) || 480) + 120) / 60))
      : 20,
  );
  const [activeNumber, setActiveNumber] = useState(
    paperMode
      ? normalizedParts[viewedPart]?.first || 1
      : navigation[0]?.number || 1,
  );
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
    dialog = useRef<HTMLDivElement>(null),
    selectionMenu = useRef<HTMLDivElement>(null),
    notesInput = useRef<HTMLTextAreaElement>(null),
    optionsTrigger = useRef<HTMLButtonElement>(null),
    notesTrigger = useRef<HTMLButtonElement>(null);
  const modalReturnFocus = useRef<HTMLElement | null>(null),
    previousModal = useRef<Modal>(null),
    splitCleanup = useRef<(() => void) | null>(null);
  const sessionRef = useRef(session),
    screenRef = useRef(screen),
    audioPosition = useRef(session.audioPosition || 0),
    submitted = useRef(false);
  sessionRef.current = session;
  screenRef.current = screen;
  const saveError = useSaveError();
  const audioIndex = paperMode ? session.audioIndex || 0 : 0;
  const playingItem = paperMode
    ? paperItems[audioIndex] || initialItem
    : initialItem;
  const playingData = playingItem.data?.data?.questions
    ? playingItem.data.data
    : playingItem.data || {};
  const src = mediaUrl(playingItem, playingData.audioUrl);
  const part = paperMode ? viewedPart + 1 : Number(data.part) || 1;
  const first = paperMode
      ? normalizedParts[viewedPart]?.first || 1
      : navigation[0]?.number || 1,
    last = paperMode
      ? normalizedParts[viewedPart]?.last || first
      : navigation.at(-1)?.number || first;
  const activeEntry = navigationEntries.find(
    (entry) => activeNumber >= entry.number && activeNumber <= entry.endNumber,
  );
  const activeEntryIndex = navigationEntries.findIndex(
    (entry) => entry === activeEntry,
  );
  const audioToPlay = useRef(false),
    pendingAudioPosition = useRef<number | null>(null);
  const audioRequest = useRef(0),
    audioCheckpointAt = useRef(0),
    disposed = useRef(false);
  const autoStarted = useRef(false),
    completionNotified = useRef(false);
  const scrollPositions = useRef<
    Record<number, { passage: number; questions: number }>
  >({});
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
    const next = { ...sessionRef.current, ...patch };
    sessionRef.current = next;
    setSession(next);
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
      ? navigator.locks.request("ielts-lab-progress-write", operation)
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
    if (
      !paperMode ||
      paperMode.autoStart === false ||
      autoStarted.current ||
      paperError ||
      submitted.current
    )
      return;
    autoStarted.current = true;
    if (previous?.phase === "complete") {
      if (previous.attemptIds?.length === paperItems.length) {
        submitted.current = true;
        setScreen("complete");
      } else void finish(previous.finishReason === "timeout");
    } else start(!!previous);
  }, [paperMode, paperError]);
  useEffect(() => {
    if (
      !paperMode ||
      session.phase !== "complete" ||
      session.attemptIds?.length !== paperItems.length ||
      completionNotified.current
    )
      return;
    completionNotified.current = true;
    paperMode.onComplete({
      attemptIds: session.attemptIds,
      finishedAt: session.completedAt || Date.now(),
      reason: session.finishReason || "submitted",
    });
  }, [
    paperMode,
    session.phase,
    session.attemptIds,
    session.completedAt,
    session.finishReason,
  ]);
  useEffect(() => {
    if (
      !paperMode ||
      !audioToPlay.current ||
      screenRef.current === "setup" ||
      sessionRef.current.phase === "complete"
    )
      return;
    audioToPlay.current = false;
    playAudio(0);
  }, [audioIndex, src]);
  useEffect(() => {
    if (modal) {
      if (!previousModal.current)
        modalReturnFocus.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : optionsTrigger.current;
      setSelection(null);
      requestAnimationFrame(() =>
        dialog.current?.querySelector<HTMLButtonElement>("button")?.focus(),
      );
    } else if (previousModal.current) {
      const target = modalReturnFocus.current;
      requestAnimationFrame(() => {
        if (target?.isConnected) target.focus({ preventScroll: true });
        else optionsTrigger.current?.focus({ preventScroll: true });
      });
    }
    previousModal.current = modal;
  }, [modal]);
  useEffect(() => {
    if (!selection) return;
    if (selection.keyboard)
      requestAnimationFrame(() =>
        selectionMenu.current
          ?.querySelector<HTMLButtonElement>("button")
          ?.focus(),
      );
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        event.preventDefault();
        selection.returnFocus?.focus({ preventScroll: true });
      } else if (selectionMenu.current?.contains(event.target as Node)) return;
      setSelection(null);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [selection]);
  useEffect(() => {
    if (notesOpen) requestAnimationFrame(() => notesInput.current?.focus());
  }, [notesOpen]);
  useEffect(() => () => splitCleanup.current?.(), []);
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
    disposed.current = false;
    const element = root.current,
      player = audio.current;
    return () => {
      disposed.current = true;
      // StrictMode immediately remounts effects; stop only after a real unmount.
      queueMicrotask(() => {
        if (!disposed.current) return;
        audioRequest.current++;
        player?.pause();
        if (document.fullscreenElement === element)
          document.exitFullscreen().catch(() => {});
      });
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
    if (conflictRef.current || paperError || submitted.current) return;
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
        startedAt: paperMode?.startedAt ?? Date.now(),
        deadline: paperMode
          ? listening
            ? null
            : paperReadingDeadline(paperMode.startedAt)
          : timed
            ? Date.now() + Math.max(1, Math.min(180, minutes)) * 60000
            : null,
        audioIndex: 0,
        viewedPart: 0,
      };
    }
    submitted.current = false;
    audioPosition.current = next.audioPosition;
    setViewedPart(next.viewedPart || 0);
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
    ) {
      if (paperMode && resume) {
        setAudioBlocked(true);
        setAudioError(
          `Part ${(next.audioIndex || 0) + 1} is paused at its saved position. Select Resume audio to continue.`,
        );
      } else playAudio(next.audioPosition);
    }
  }
  function playAudio(position = audioPosition.current) {
    const player = audio.current;
    if (
      !player ||
      conflictRef.current ||
      sessionRef.current.phase === "complete" ||
      sessionRef.current.audioEnded
    )
      return;
    const playItem = paperMode
      ? paperItems[sessionRef.current.audioIndex || 0]
      : initialItem;
    const playData = playItem?.data?.data?.questions
      ? playItem.data.data
      : playItem?.data || {};
    const playSrc = playItem ? mediaUrl(playItem, playData.audioUrl) : "";
    if (!playSrc) {
      setAudioBlocked(true);
      setAudioError(
        "This audio part is unavailable. Restore the local file before resuming; no part has been skipped.",
      );
      return;
    }
    if (player.error || player.getAttribute("src") !== playSrc) {
      player.setAttribute("src", playSrc);
      player.load();
    }
    pendingAudioPosition.current = position;
    if (player.readyState >= 1) {
      player.currentTime = position;
      pendingAudioPosition.current = null;
    }
    player.playbackRate = 1;
    player.volume = volume;
    const request = ++audioRequest.current;
    player
      .play()
      .then(() => {
        if (disposed.current) {
          player.pause();
          return;
        }
        if (request !== audioRequest.current) return;
        setAudioBlocked(false);
        setAudioError("");
      })
      .catch(() => {
        if (disposed.current || request !== audioRequest.current) return;
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
      (sessionRef.current.phase === "complete" &&
        (!paperMode ||
          sessionRef.current.attemptIds?.length === paperItems.length)) ||
      (paperMode && listening && !sessionRef.current.audioEnded)
    )
      return;
    submitted.current = true;
    setSubmitting(true);
    audio.current?.pause();
    const current = snapshot(),
      completedAt =
        current.completedAt ||
        (automatic && current.deadline !== null
          ? current.deadline
          : Date.now());
    const result = gradeGroups(groups, current.answers);
    const work = pendingWrites.current
      .catch(() => false)
      .then(() =>
        lock(() => {
          const checkpoint: Session = {
            ...current,
            phase: "complete",
            completedAt,
            finishReason: automatic ? "timeout" : "submitted",
          };
          if (!saveChecked(checkpoint)) return false;
          if (paperMode) {
            const attemptIds: string[] = [];
            const totalDuration = elapsedSeconds(
              current.startedAt,
              completedAt,
              current.deadline,
            );
            for (const [index, material] of paperItems.entries()) {
              const partData = normalizedParts[index];
              const partAnswers = answersForPart(partData, current.answers);
              const partGrade = gradeGroups(
                partData.originalGroups,
                partAnswers,
              );
              const marker = JSON.stringify([
                paperMode.paperId,
                paperMode.runId,
              ]);
              const existing = getProgress().attempts.find(
                (attempt) =>
                  attempt.itemId === material.id &&
                  attempt.answers?.__paperSession === marker,
              );
              if (existing) {
                attemptIds.push(existing.id);
                continue;
              }
              recordAttempt({
                itemId: material.id,
                title: material.title,
                kind: material.kind,
                answers: { ...partAnswers, __paperSession: marker },
                score: partGrade.score,
                total: partGrade.total,
                durationSeconds: index === 0 ? totalDuration : 0,
                detail: `${paperMode.shortDemo ? "Short original paper demonstration" : "Full-paper practice"} · Part ${index + 1}${automatic ? " · time limit reached" : ""}`,
              });
              const attempt = getProgress().attempts[0];
              if (attempt?.itemId === material.id) attemptIds.push(attempt.id);
            }
            const next: Session = { ...checkpoint, attemptIds };
            if (!saveChecked(next)) return false;
            sessionRef.current = next;
            setSession(next);
            setPrevious(next);
            setScreen("complete");
            setModal(null);
            setSelection(null);
            return true;
          }
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
  function go(
    number: number | undefined,
    restoreScroll = false,
    focusAnswer = true,
  ) {
    if (
      number === undefined ||
      conflictRef.current ||
      sessionRef.current.phase === "complete" ||
      submitting
    )
      return;
    const target = navigationEntries.find(
      (nav) => number >= nav.number && number <= nav.endNumber,
    );
    if (!target) return;
    if (paperMode) {
      const nextPart = normalizedParts.findIndex(
        (part) => number >= part.first && number <= part.last,
      );
      if (nextPart >= 0 && nextPart !== viewedPart) {
        scrollPositions.current[viewedPart] = {
          passage:
            panes.current?.querySelector(".ct-reading-passage")?.scrollTop || 0,
          questions:
            panes.current?.querySelector(".ct-questions")?.scrollTop || 0,
        };
        setViewedPart(nextPart);
        update({ viewedPart: nextPart });
      }
    }
    setActiveNumber(target.number);
    setSelection(null);
    if (screen === "submission") {
      setScreen("active");
      update({ phase: "active" });
    }
    requestAnimationFrame(() => {
      if (root.current) root.current.scrollTop = 0;
      if (restoreScroll && paperMode) {
        const targetPart = normalizedParts.findIndex(
          (part) => number >= part.first && number <= part.last,
        );
        const saved = scrollPositions.current[targetPart];
        const passage = panes.current?.querySelector(".ct-reading-passage"),
          questions = panes.current?.querySelector(".ct-questions");
        if (passage) passage.scrollTop = saved?.passage || 0;
        if (questions) questions.scrollTop = saved?.questions || 0;
        return;
      }
      const element = document.getElementById(`ct-question-${target.rowId}`);
      scrollQuestionWithinPane(
        panes.current?.querySelector<HTMLElement>(".ct-questions"),
        element,
      );
      const control = element?.matches("input,select")
        ? element
        : element?.querySelector<HTMLElement>(
            "input:not(:disabled),select,button",
          );
      if (focusAnswer)
        (control as HTMLElement | undefined)?.focus({ preventScroll: true });
    });
  }
  function navigateWithKeyboard(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    navs: QuestionNavEntry[],
    number: number,
  ) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    const next = navigationDestination(
      navs.map((nav) => nav.number),
      number,
      event.key,
    );
    if (next === null) return;
    event.preventDefault();
    go(next, false, false);
    requestAnimationFrame(() =>
      document.getElementById(`ct-nav-${next}`)?.focus({ preventScroll: true }),
    );
  }
  function partWithKeyboard(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    const next = navigationDestination(
      normalizedParts.map((_part, i) => i),
      index,
      event.key,
    );
    if (next === null) return;
    event.preventDefault();
    go(normalizedParts[next].first, true, false);
    requestAnimationFrame(() =>
      document
        .getElementById(`ct-part-nav-${next}`)
        ?.focus({ preventScroll: true }),
    );
  }
  function questionButtons(navs: QuestionNavEntry[]) {
    return navs.map((nav) => {
      const progress = navigationEntryProgress(
        nav,
        rowMap.get(nav.rowId)!,
        session.answers,
      );
      const marked = navigationEntryMarked(nav, session.marked);
      const status = progress.complete ? "Attempted" : "Not attempted";
      return (
        <button
          key={nav.number}
          id={`ct-nav-${nav.number}`}
          className={`${activeNumber === nav.number && screen === "active" ? "ct-active" : ""} ${progress.complete ? "ct-is-answered" : ""} ${marked ? "ct-marked" : ""}`}
          aria-label={`Question ${nav.label}, ${status}${marked ? ", marked for review" : ""}`}
          aria-current={
            activeNumber === nav.number && screen === "active"
              ? "step"
              : undefined
          }
          tabIndex={
            activeNumber === nav.number ||
            (!navs.some((entry) => entry.number === activeNumber) &&
              nav.number === navs[0]?.number)
              ? 0
              : -1
          }
          onKeyDown={(event) => navigateWithKeyboard(event, navs, nav.number)}
          onClick={() => go(nav.number)}
        >
          <span className="ct-question-progress" />
          {nav.label}
          {marked && <i aria-hidden="true" />}
        </button>
      );
    });
  }
  function focusRow(row: QuestionRow) {
    setActiveNumber(row.number);
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
    const entry = navigationEntries.find(
      (nav) => number >= nav.number && number <= nav.endNumber,
    );
    if (!entry) return;
    setSession((current) => ({
      ...current,
      marked: toggleNavigationEntryMark(entry, current.marked),
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
    if (value.keyboard)
      requestAnimationFrame(() =>
        value.returnFocus?.focus({ preventScroll: true }),
      );
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
    if (value.keyboard)
      requestAnimationFrame(() =>
        value.returnFocus?.focus({ preventScroll: true }),
      );
  }
  function noteSelection() {
    if (selection)
      update({
        notes: `${session.notes}${session.notes ? "\n\n" : ""}${selection.text}\n`,
      });
    setNotesOpen(true);
    setSelection(null);
    requestAnimationFrame(() => notesInput.current?.focus());
  }
  function renderContent(
    html: unknown,
    surface: string,
    gap?: (index: number) => ReactNode,
    className = "",
    textOffset = 0,
  ) {
    const keyedSurface = paperMode ? `${item.id}::${surface}` : surface;
    return (
      <Content
        html={html}
        item={item}
        surface={keyedSurface}
        marks={session.highlights[keyedSurface] || []}
        gap={gap}
        onSelection={selectText}
        className={className}
        textOffset={textOffset}
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
          autoCorrect="off"
          autoCapitalize="off"
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
        aria-describedby={`ct-prompt-${row.id}`}
      >
        <legend className="ct-sr-only">
          Question {row.number}
          {row.endNumber > row.number ? `–${row.endNumber}` : ""}
        </legend>
        <div className="ct-choice-heading" id={`ct-prompt-${row.id}`}>
          <strong aria-hidden="true">
            {row.number}
            {row.endNumber > row.number ? `–${row.endNumber}` : ""}
          </strong>
          {renderContent(row.content, `prompt-${row.id}`)}
        </div>
        {row.options.map((option) => {
          const checked = multiple
            ? selected.includes(option.value)
            : session.answers[row.id] === option.value;
          return (
            <label
              key={option.value}
              onClick={(event) => {
                if (event.target instanceof HTMLInputElement) return;
                const target = event.target as HTMLElement;
                const selectedText = window.getSelection();
                if (
                  target.closest("[data-ct-mark]") ||
                  (selectedText &&
                    !selectedText.isCollapsed &&
                    event.currentTarget.contains(selectedText.anchorNode) &&
                    event.currentTarget.contains(selectedText.focusNode))
                )
                  event.preventDefault();
              }}
            >
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
    const matrix = matchingMatrix(group);
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
        {!matrix &&
          group.optionsTitle &&
          renderContent(group.optionsTitle, `options-title-${group.id}`)}
        {group.type === "4" && !matrix && (
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
        {matrix && (
          <>
            <div className="ct-match-matrix-frame">
              <table
                className="ct-match-matrix"
                style={{ minWidth: 220 + matrix.options.length * 42 }}
                aria-label="Table of options to match"
              >
                <thead>
                  <tr>
                    <th scope="col">
                      <span className="ct-sr-only">Statement</span>
                    </th>
                    {matrix.options.map((option) => (
                      <th key={option.value} scope="col">
                        {option.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matrix.rows.map((statement) => {
                    const row = rowMap.get(statement.rowId)!;
                    // Retain original content-surface offsets so existing highlights survive the layout change.
                    const prefix = document.createElement("div");
                    prefix.innerHTML = safeHTML(statement.beforeHtml);
                    const offset = (prefix.textContent || "").replace(
                      /\.{6}/g,
                      "",
                    ).length;
                    return (
                      <tr key={row.id} id={`ct-question-${row.id}`}>
                        <th scope="row">
                          <div className="ct-matrix-statement">
                            <strong
                              className={`ct-matrix-number ${activeNumber === row.number ? "ct-active" : ""}`}
                            >
                              {row.number}
                            </strong>
                            {renderContent(
                              statement.html,
                              `content-${group.id}`,
                              undefined,
                              "",
                              offset,
                            )}
                          </div>
                        </th>
                        {matrix.options.map((option) => (
                          <td key={option.value}>
                            <label>
                              <input
                                type="radio"
                                name={`ct-${row.id}`}
                                value={option.value}
                                checked={
                                  session.answers[row.id] === option.value
                                }
                                disabled={submitting}
                                aria-label={`Question ${row.number}, ${option.label}`}
                                onFocus={() => focusRow(row)}
                                onChange={() => answer(row, option.value)}
                              />
                            </label>
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {(matrix.kind === "features" || group.optionsTitle) && (
              <div className="ct-match-legend">
                {group.optionsTitle ? (
                  renderContent(group.optionsTitle, `options-title-${group.id}`)
                ) : (
                  <strong>List of options</strong>
                )}
                <table aria-label="Matching option descriptions">
                  <tbody>
                    {matrix.options.map((option) => (
                      <tr key={option.value}>
                        <th scope="row">{option.label}</th>
                        <td>
                          {renderContent(
                            option.content,
                            `matching-option-${group.id}-${option.value}`,
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        {!matrix &&
          group.content &&
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
        {matrix ? null : ["1", "2", "3"].includes(group.type) ? (
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

  return (
    <div
      ref={root}
      {...ieltsExamAttrs(contrast, textSize)}
      className={`vg vg-exam computer-test ct-contrast-${contrast} ct-size-${textSize} ${paperMode ? "ct-paper-mode" : ""}`}
    >
      <audio
        ref={audio}
        src={src || undefined}
        preload="metadata"
        onPlaying={() => {
          setAudioPlaying(true);
          setAudioBlocked(false);
        }}
        onPause={() => {
          setAudioPlaying(false);
          if (
            paperMode &&
            !disposed.current &&
            !submitted.current &&
            !conflictRef.current &&
            screenRef.current !== "setup" &&
            !sessionRef.current.audioEnded &&
            !audio.current?.ended &&
            !audioToPlay.current
          ) {
            setAudioBlocked(true);
            setAudioError(
              "Audio was interrupted. Select Resume audio to continue from the saved position.",
            );
          }
        }}
        onTimeUpdate={() => {
          if (
            audio.current &&
            pendingAudioPosition.current === null &&
            !audio.current.paused
          ) {
            audioPosition.current = audio.current.currentTime;
            if (
              paperMode &&
              !submitted.current &&
              Date.now() - audioCheckpointAt.current >= 1000
            ) {
              audioCheckpointAt.current = Date.now();
              void persist(snapshot());
            }
          }
        }}
        onLoadedMetadata={() => {
          if (audio.current && pendingAudioPosition.current !== null) {
            audio.current.currentTime = pendingAudioPosition.current;
            pendingAudioPosition.current = null;
          }
        }}
        onEnded={() => {
          setAudioPlaying(false);
          if (
            conflictRef.current ||
            sessionRef.current.phase === "complete" ||
            screenRef.current === "setup"
          )
            return;
          if (paperMode) {
            const next = advancePaperAudio(
              sessionRef.current,
              audioIndex,
              paperItems.length,
              Date.now(),
            );
            if (!next) return;
            audioPosition.current = 0;
            audioToPlay.current = !next.audioEnded;
            update(next);
            void persist(snapshot());
          } else update({ audioEnded: true });
        }}
        onError={() => {
          setAudioPlaying(false);
          audioToPlay.current = false;
          setAudioBlocked(true);
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
            <h1>
              {paperMode
                ? paperMode.shortDemo
                  ? "Short paper flow demonstration"
                  : "Full-paper practice"
                : "Single-part practice"}
            </h1>
            <p className="ct-setup-title">{item.title}</p>
            <p className="ct-track-note">
              <strong>{trackLabel}</strong>
              {item.source === "original" && (
                <span className="ct-source-label">
                  Original practice material
                </span>
              )}
            </p>
            {paperMode ? (
              <>
                <p>
                  {listening
                    ? "Four listening parts play in order, followed by two minutes to check all answers. Changing the question part does not change the recording."
                    : "Three reading parts share one 60-minute timer. The deadline continues when you switch parts or leave the page."}
                </p>
                {paperMode.shortDemo && (
                  <p className="ct-paper-notice">
                    Original short demonstration: this paper has{" "}
                    {navigation.length} questions. It demonstrates the sequence
                    and controls; it is not a full-length test.
                  </p>
                )}
                {listening && (
                  <p>
                    Local recordings retain their own pauses and instructions.
                    Their timing and recorded cues may differ from an official
                    test; the final two-minute check is added by this app.
                  </p>
                )}
                {paperError && <p className="ct-error">{paperError}</p>}
              </>
            ) : (
              <>
                <p>
                  Practise the computer-test controls using your own local
                  material. This session contains one{" "}
                  {listening
                    ? "listening part"
                    : item.testTrack === "general"
                      ? "reading practice section"
                      : "reading passage"}
                  , not a complete IELTS test.
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
                    The time limit is your practice setting. The timer continues
                    if you leave this page.
                  </small>
                </fieldset>
              </>
            )}
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
                disabled={
                  !rows.length ||
                  !!paperError ||
                  (!!paperMode && previous?.phase === "complete")
                }
                onClick={() => {
                  if (!paperMode) submitted.current = false;
                  start(!!paperMode && !!previous);
                }}
              >
                {paperMode && previous?.phase !== "complete" && previous
                  ? "Resume practice"
                  : previous
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
              <small className="ct-track-label">
                {trackLabel}
                {paperMode ? " · Paper practice" : ""}
              </small>
              <span>
                {listening ? (
                  <>
                    <Volume2 size={16} />
                    {session.audioEnded
                      ? "Audio has finished"
                      : audioPlaying
                        ? paperMode
                          ? `Audio is Playing · Part ${audioIndex + 1}`
                          : "Audio is Playing"
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
                ref={optionsTrigger}
                title="Options"
                aria-label="Options"
                onClick={() => setModal("options")}
              >
                <Menu size={25} />
              </button>
              <button
                ref={notesTrigger}
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
              {audioError || saveError}
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
                      {listening
                        ? "Listen"
                        : item.testTrack === "general"
                          ? "Read the texts"
                          : "Read the passage"}{" "}
                      and answer questions {first}–{last}.
                    </p>
                    {paperMode && listening && (
                      <span className="ct-short-demo">
                        Local recording timings · two-minute final answer check
                      </span>
                    )}
                    {paperMode?.shortDemo && (
                      <span className="ct-short-demo">
                        Short original demo · {navigation.length} questions
                      </span>
                    )}
                    {paperMode && listening && session.audioEnded && (
                      <span className="ct-short-demo">Final answer check</span>
                    )}
                  </div>
                  <div
                    className={`ct-panes ${listening ? "ct-listening" : "ct-reading"}`}
                    ref={panes}
                  >
                    {!listening && (
                      <>
                        <div
                          className="ct-reading-passage"
                          role="region"
                          aria-label={`Reading text, Part ${part}`}
                          tabIndex={0}
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
                          aria-valuenow={Math.round(split)}
                          aria-valuetext={`Reading text ${Math.round(split)} percent, questions ${100 - Math.round(split)} percent`}
                          title="Drag to resize. Arrow keys adjust; Home/End set limits; Enter resets."
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
                      </>
                    )}
                    <div className="ct-question-column">
                      <div
                        className="ct-questions"
                        role="region"
                        aria-label={`Questions ${first} to ${last}`}
                        tabIndex={0}
                      >
                        {visibleGroups.map(groupView)}
                        <div className="ct-review-marker">
                          <label>
                            <input
                              type="checkbox"
                              checked={
                                !!activeEntry &&
                                navigationEntryMarked(
                                  activeEntry,
                                  session.marked,
                                )
                              }
                              onChange={() => markQuestion(activeNumber)}
                            />{" "}
                            Mark question {activeEntry?.label || activeNumber}{" "}
                            for review
                          </label>
                        </div>
                      </div>
                      <div className="ct-step-controls">
                        <button
                          aria-label="Previous question"
                          disabled={activeEntryIndex <= 0}
                          onClick={() =>
                            go(navigationEntries[activeEntryIndex - 1]?.number)
                          }
                        >
                          <ArrowLeft size={27} />
                        </button>
                        <button
                          aria-label="Next question"
                          disabled={
                            activeEntryIndex >= navigationEntries.length - 1
                          }
                          onClick={() =>
                            go(navigationEntries[activeEntryIndex + 1]?.number)
                          }
                        >
                          <ArrowRight size={27} />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
                {notesOpen && (
                  <aside className="ct-notes">
                    <div>
                      <strong>Notes{paperMode ? " · all parts" : ""}</strong>
                      <button
                        aria-label="Hide notes"
                        onClick={() => {
                          setNotesOpen(false);
                          notesTrigger.current?.focus({ preventScroll: true });
                        }}
                      >
                        <X size={20} />
                      </button>
                    </div>
                    <textarea
                      ref={notesInput}
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
              <h2>{paperMode ? "All parts" : `Part ${part}`}</h2>
              <div className="ct-review-grid">
                {navigationEntries.map((nav) => {
                  const progress = navigationEntryProgress(
                    nav,
                    rowMap.get(nav.rowId)!,
                    session.answers,
                  );
                  const marked = navigationEntryMarked(nav, session.marked);
                  return (
                    <button
                      key={nav.number}
                      className={`${progress.complete ? "ct-is-answered" : ""} ${marked ? "ct-marked" : ""}`}
                      onClick={() => go(nav.number)}
                    >
                      <strong>{nav.label}</strong>
                      <span>
                        {progress.complete
                          ? "Answered"
                          : progress.answered
                            ? `${progress.answered} of ${progress.total} answered`
                            : "Not answered"}
                      </span>
                      {marked && <Flag size={15} />}
                    </button>
                  );
                })}
              </div>
              {paperMode && listening && !session.audioEnded && (
                <p className="ct-paper-notice">
                  You can review answers while the recording continues.
                  Submission becomes available after all four recordings finish.
                  Audio problems must be resolved before completing this
                  section.
                </p>
              )}
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
                  disabled={
                    submitting ||
                    (!!paperMode && listening && !session.audioEnded)
                  }
                >
                  {submitting ? "Saving answers…" : "Submit answers"}
                </button>
              </div>
            </main>
          ) : (
            <main className="ct-complete">
              <h1>Practice submitted</h1>
              <p>Your answers have been saved to your learning history.</p>
              {item.kind === "listening" && !paperMode && (
                <DailyAttemptBanner
                  itemId={item.id}
                  attemptId={session.attemptId}
                />
              )}
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
              <p>
                This {paperMode ? "paper practice" : "single-part practice"}{" "}
                score is not an IELTS band score.
              </p>
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
                {!paperMode && (
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
                )}
              </div>
            </main>
          )}
          {screen !== "complete" && (
            <footer
              className={`ct-footer ${paperMode ? "ct-paper-footer" : ""}`}
            >
              {paperMode ? (
                <nav
                  className="ct-paper-navigation"
                  aria-label="Paper parts and questions"
                >
                  {normalizedParts.map((entry, index) => {
                    const navs = navigation.filter(
                      (nav) =>
                        nav.number >= entry.first && nav.number <= entry.last,
                    );
                    const completed = navs.filter((nav) =>
                      answeredQuestion(
                        nav,
                        rowMap.get(nav.rowId)!,
                        session.answers,
                      ),
                    ).length;
                    const entries = navigationEntries.filter(
                      (nav) =>
                        nav.number >= entry.first && nav.number <= entry.last,
                    );
                    const reviewCount = entries.filter((nav) =>
                      navigationEntryMarked(nav, session.marked),
                    ).length;
                    const expanded = index === viewedPart;
                    return (
                      <div
                        className={`ct-nav-part ${expanded ? "ct-nav-part-expanded" : ""}`}
                        key={entry.itemId}
                      >
                        <button
                          className="ct-part-heading"
                          id={`ct-part-nav-${index}`}
                          aria-expanded={expanded}
                          aria-controls={`ct-part-questions-${index}`}
                          aria-label={`Part ${index + 1}, ${completed} of ${navs.length} answered${reviewCount ? `, ${reviewCount} marked for review` : ""}`}
                          onClick={() => go(entry.first, true)}
                          onKeyDown={(event) => partWithKeyboard(event, index)}
                        >
                          <strong>Part {index + 1}</strong>
                          {!expanded && (
                            <span>
                              {completed} of {navs.length}
                            </span>
                          )}
                          {reviewCount > 0 && (
                            <Flag size={13} aria-hidden="true" />
                          )}
                        </button>
                        <div
                          className="ct-question-numbers"
                          id={`ct-part-questions-${index}`}
                          hidden={!expanded}
                        >
                          {questionButtons(entries)}
                        </div>
                      </div>
                    );
                  })}
                </nav>
              ) : (
                <div className="ct-part">
                  <strong>Part {part}</strong>
                  <nav
                    className="ct-question-numbers"
                    aria-label="Question navigation"
                  >
                    {questionButtons(navigationEntries)}
                  </nav>
                </div>
              )}
              {!paperMode && (
                <span className="ct-answer-count">
                  {answered} of {navigation.length}
                </span>
              )}
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
          ref={selectionMenu}
          role="toolbar"
          aria-label="Selected text actions"
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
            onClick={() => {
              selection.returnFocus?.focus({ preventScroll: true });
              setSelection(null);
            }}
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
                modal === "contrast" || modal === "text" || modal === "help"
                  ? "options"
                  : null,
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
                    : modal === "help"
                      ? "Using this practice"
                      : "Leave this practice?"}
            </h1>
            {modal === "options" ? (
              <div className="ct-option-choices">
                {session.phase !== "complete" && (
                  <button onClick={submission}>Go to submission page</button>
                )}
                <button onClick={() => setModal("contrast")}>Contrast</button>
                <button onClick={() => setModal("text")}>Text size</button>
                <button onClick={() => setModal("help")}>Help</button>
                <button onClick={() => setModal("exit")}>Exit practice</button>
              </div>
            ) : modal === "help" ? (
              <div className="ct-help">
                <p>These instructions describe IELTS Lab practice controls.</p>
                <dl>
                  <dt>Move between questions</dt>
                  <dd>
                    Select a question number or use the black Previous and Next
                    buttons. In the question bar, use Left/Right or Home/End to
                    move. Select a Part to open its questions.
                  </dd>
                  <dt>Review an answer</dt>
                  <dd>
                    Use “Mark question for review” below the questions. A dot
                    stays beside its number. An answered question has a dark
                    line above its number.
                  </dd>
                  {!listening && (
                    <>
                      <dt>Reading text and questions</dt>
                      <dd>
                        Each side scrolls independently. Drag the divider or
                        focus it and use Left/Right. Home/End set the limits;
                        Enter or a double click returns to equal widths.
                      </dd>
                    </>
                  )}
                  <dt>Highlight and notes</dt>
                  <dd>
                    Select text to open the text actions, or use Shift+F10 after
                    a keyboard selection. Highlight marks the selection; Note
                    copies it into your notes. Escape closes text actions.
                  </dd>
                  {listening && (
                    <>
                      <dt>Listening audio</dt>
                      <dd>
                        Changing questions does not seek, skip or restart the
                        recording. Use the volume control to adjust the sound.
                      </dd>
                    </>
                  )}
                  <dt>Options and timing</dt>
                  <dd>
                    Contrast and Text size change the display. Options and notes
                    do not pause a running timer or audio.
                  </dd>
                </dl>
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
