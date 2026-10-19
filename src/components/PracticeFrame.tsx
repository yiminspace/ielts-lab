import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Bookmark, Menu, NotebookPen, X } from "lucide-react";
import type { StudyItem } from "../types";
import {
  saveNote,
  toggleBookmark,
  useProgress,
  useSaveError,
} from "../lib/progress";
import "../computer-test.css";
import "../practice-frame.css";

export type PracticeFrameProps = {
  item: StudyItem;
  mode: "practice" | "review";
  status?: ReactNode;
  instruction?: ReactNode;
  actions?: ReactNode;
  tools?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  onExit?: () => void;
  onExam?: () => void;
};

/** Shared presentation for daily work and saved attempts; session data stays with each workspace. */
export default function PracticeFrame({
  item,
  mode,
  status,
  instruction,
  actions,
  tools,
  footer,
  children,
  onExit,
  onExam,
}: PracticeFrameProps) {
  const progress = useProgress();
  const saveError = useSaveError();
  const [notesOpen, setNotesOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [contrast, setContrast] = useState("black-white");
  const [textSize, setTextSize] = useState("regular");
  const options = useRef<HTMLDialogElement>(null);
  const notes = useRef<HTMLTextAreaElement>(null);
  const notesTrigger = useRef<HTMLButtonElement>(null);
  const exit =
    onExit ||
    (() => {
      location.hash = mode === "review" ? "/history" : `/library/${item.kind}`;
    });
  const skill =
    item.kind === "listening"
      ? "Listening"
      : item.kind === "reading"
        ? "Reading"
        : "Writing";
  const track =
    item.testTrack === "general"
      ? "General Training"
      : item.testTrack === "academic"
        ? "Academic"
        : item.testTrack === "shared"
          ? "Academic / General Training"
          : "类别待确认";
  useEffect(() => {
    if (optionsOpen) options.current?.showModal();
    else options.current?.close();
  }, [optionsOpen]);
  useEffect(() => {
    if (notesOpen) notes.current?.focus();
  }, [notesOpen]);
  const closeNotes = () => {
    setNotesOpen(false);
    notesTrigger.current?.focus();
  };
  return (
    <div
      className={`computer-test practice-frame ct-contrast-${contrast} ct-size-${textSize}`}
    >
      <header className="pf-header">
        <button className="pf-back" aria-label="返回" onClick={exit}>
          <ArrowLeft size={19} />
        </button>
        <span className="ct-own-brand pf-brand">IELTS Lab</span>
        <div className="pf-identity">
          <strong>{item.title}</strong>
          <span>
            {skill} · {track}
            {item.source === "original" ? " · 原创练习" : ""}
          </span>
        </div>
        <div className="pf-status">{status}</div>
        <div className="pf-header-actions">
          <button
            ref={notesTrigger}
            aria-label="Notes"
            title="材料学习笔记"
            aria-expanded={notesOpen}
            aria-controls="practice-notes"
            onClick={() => (notesOpen ? closeNotes() : setNotesOpen(true))}
          >
            <NotebookPen size={21} />
            <span>Notes</span>
          </button>
          <button aria-label="Options" onClick={() => setOptionsOpen(true)}>
            <Menu size={21} />
            <span>Options</span>
          </button>
        </div>
      </header>
      <div className="pf-instruction">
        <div>{instruction || <strong>{skill}</strong>}</div>
        <span className="pf-mode">
          {mode === "review" ? "Review · 作答复盘" : "Practice · 日常练习"}
        </span>
        {actions && <div className="pf-actions">{actions}</div>}
      </div>
      {saveError && (
        <div className="pf-save-message" role="status">
          {saveError}
        </div>
      )}
      {tools && <div className="pf-tools">{tools}</div>}
      <div className="pf-workarea">
        <div className="pf-content">{children}</div>
        {notesOpen && (
          <aside
            className="pf-notes"
            id="practice-notes"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                closeNotes();
              }
            }}
          >
            <div>
              <strong>材料学习笔记</strong>
              <button aria-label="关闭笔记" onClick={closeNotes}>
                <X size={18} />
              </button>
            </div>
            <p>
              {mode === "review"
                ? "材料的当前笔记，只读查看。"
                : "随材料保存，可在下次练习继续使用。"}
            </p>
            <textarea
              ref={notes}
              aria-label="材料学习笔记"
              readOnly={mode === "review"}
              value={progress.notes[item.id] || ""}
              onChange={(event) => saveNote(item.id, event.target.value)}
              placeholder="Type your notes here…"
            />
          </aside>
        )}
      </div>
      {footer && <footer className="pf-footer">{footer}</footer>}
      <dialog
        ref={options}
        className="pf-options"
        aria-labelledby="practice-options-title"
        onCancel={() => setOptionsOpen(false)}
        onClose={() => setOptionsOpen(false)}
      >
        <div className="pf-dialog-heading">
          <h2 id="practice-options-title">Options</h2>
          <button
            aria-label="关闭 Options"
            onClick={() => setOptionsOpen(false)}
          >
            <X size={20} />
          </button>
        </div>
        <label>
          Text size
          <select
            aria-label="Text size"
            value={textSize}
            onChange={(event) => setTextSize(event.target.value)}
          >
            <option value="regular">Regular</option>
            <option value="large">Large</option>
            <option value="extra">Extra large</option>
          </select>
        </label>
        <label>
          Contrast
          <select
            aria-label="Contrast"
            value={contrast}
            onChange={(event) => setContrast(event.target.value)}
          >
            <option value="black-white">Black on white</option>
            <option value="white-black">White on black</option>
            <option value="yellow-black">Yellow on black</option>
          </select>
        </label>
        <button
          className="pf-menu-action"
          onClick={() => toggleBookmark(item.id)}
          aria-pressed={progress.bookmarks.includes(item.id)}
        >
          <Bookmark size={18} />
          {progress.bookmarks.includes(item.id)
            ? "已收藏 · 取消收藏"
            : "收藏这份材料"}
        </button>
        {onExam && (
          <button
            className="pf-menu-action"
            onClick={() => {
              setOptionsOpen(false);
              onExam();
            }}
          >
            考试练习…
          </button>
        )}
        <button
          className="pf-menu-action"
          onClick={() => {
            setOptionsOpen(false);
            exit();
          }}
        >
          返回
        </button>
      </dialog>
    </div>
  );
}
