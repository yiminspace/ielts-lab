import { Fragment, useEffect, useRef, useState } from "react";
import { useRuntime } from "../lib/runtime";

type Span = { start: number; end: number };

export default function DailyPassage({
  lessonId,
  text,
}: {
  lessonId: string;
  text: string;
}) {
  const { userId } = useRuntime();
  const storageKey = `ielts-daily:${userId || "local"}:${lessonId}:highlights`;
  // Remount when the account, lesson or passage changes so offsets never leak.
  return (
    <Passage
      key={JSON.stringify([storageKey, text])}
      storageKey={storageKey}
      text={text}
    />
  );
}

function Passage({ storageKey, text }: { storageKey: string; text: string }) {
  const passage = useRef<HTMLParagraphElement>(null);
  const [marks, setMarks] = useState<Span[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
      if (saved?.text !== text || !Array.isArray(saved.marks)) return [];
      return saved.marks.filter(
        (mark: Span) =>
          Number.isInteger(mark?.start) &&
          Number.isInteger(mark?.end) &&
          mark.start >= 0 &&
          mark.start < mark.end &&
          mark.end <= text.length,
      );
    } catch {
      return [];
    }
  });
  const [selection, setSelection] = useState<Span | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    function capture() {
      const selected = window.getSelection();
      const root = passage.current;
      if (!root || !selected?.rangeCount || selected.isCollapsed) {
        setSelection(null);
        return;
      }
      const range = selected.getRangeAt(0);
      if (
        !root.contains(range.startContainer) ||
        !root.contains(range.endContainer) ||
        !selected.toString().trim()
      ) {
        setSelection(null);
        return;
      }
      const prefix = range.cloneRange();
      prefix.selectNodeContents(root);
      prefix.setEnd(range.startContainer, range.startOffset);
      const start = prefix.toString().length;
      setSelection({ start, end: start + range.toString().length });
    }
    document.addEventListener("selectionchange", capture);
    return () => document.removeEventListener("selectionchange", capture);
  }, []);

  function save(next: Span[]) {
    setMarks(next);
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    try {
      localStorage.setItem(storageKey, JSON.stringify({ text, marks: next }));
      setStatus("高亮已保存在此浏览器");
    } catch {
      setStatus("浏览器未能保存高亮，刷新后会丢失");
    }
  }

  function highlight() {
    if (!selection) return;
    const sorted = [...marks, selection].sort((a, b) => a.start - b.start);
    const merged: Span[] = [];
    for (const span of sorted) {
      const previous = merged.at(-1);
      if (previous && span.start <= previous.end)
        previous.end = Math.max(previous.end, span.end);
      else merged.push({ ...span });
    }
    save(merged);
  }

  function clearSelection() {
    if (!selection) return;
    save(
      marks.flatMap((mark) => {
        if (mark.end <= selection.start || mark.start >= selection.end)
          return [mark];
        return [
          ...(mark.start < selection.start
            ? [{ start: mark.start, end: selection.start }]
            : []),
          ...(mark.end > selection.end
            ? [{ start: selection.end, end: mark.end }]
            : []),
        ];
      }),
    );
  }

  const boundaries = [
    ...new Set([
      0,
      text.length,
      ...marks.flatMap((mark) => [mark.start, mark.end]),
    ]),
  ].sort((a, b) => a - b);
  return (
    <>
      <div className="daily-highlight-tools" role="group" aria-label="原文高亮">
        <button
          disabled={!selection}
          onMouseDown={(event) => event.preventDefault()}
          onClick={highlight}
        >
          高亮选中
        </button>
        <button
          disabled={
            !selection ||
            !marks.some(
              (mark) =>
                mark.start < selection.end && mark.end > selection.start,
            )
          }
          onMouseDown={(event) => event.preventDefault()}
          onClick={clearSelection}
        >
          清除选中高亮
        </button>
        <button disabled={!marks.length} onClick={() => save([])}>
          清除全部高亮
        </button>
        <span role="status">
          {status || "选中英文后可高亮，仅保存在此浏览器"}
        </span>
      </div>
      <p ref={passage} lang="en" className="daily-passage-text">
        {boundaries.slice(0, -1).map((start, index) => {
          const end = boundaries[index + 1];
          const content = text.slice(start, end);
          return marks.some(
            (mark) => mark.start <= start && mark.end >= end,
          ) ? (
            <mark key={start}>{content}</mark>
          ) : (
            <Fragment key={start}>{content}</Fragment>
          );
        })}
      </p>
    </>
  );
}
