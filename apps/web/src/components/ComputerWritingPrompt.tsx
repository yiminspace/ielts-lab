import { useMemo, useRef } from "react";
import DOMPurify from "dompurify";
import {
  writingHighlightRanges,
  type WritingHighlight,
} from "../lib/computer-writing-ui.mjs";

export type WritingSelection = WritingHighlight & {
  text: string;
  x: number;
  y: number;
};

export default function ComputerWritingPrompt({
  html,
  marks,
  onSelection,
}: {
  html: unknown;
  marks?: WritingHighlight[];
  onSelection: (selection: WritingSelection | null) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const content = useMemo(() => {
    // Keep the same sanitisation policy as RichText. Highlight wrappers only
    // contain text nodes; saved offsets never become HTML or attributes.
    const safe = DOMPurify.sanitize(String(html || ""), {
      FORBID_TAGS: ["style", "script", "iframe", "form", "input", "button"],
      FORBID_ATTR: ["style"],
      ALLOWED_URI_REGEXP:
        /^(?:\/(?!\/)|#|data:image\/(?:png|jpeg|webp);base64,)/i,
    });
    const ranges = writingHighlightRanges(marks);
    if (!ranges.length) return safe;
    const body = document.createElement("div");
    body.innerHTML = safe;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    let offset = 0;
    for (const node of nodes) {
      const value = node.data;
      const start = offset;
      offset += value.length;
      const active = ranges.filter(
        (range) => range.start < offset && range.end > start,
      );
      if (!active.length) continue;
      const points = [
        ...new Set([
          0,
          value.length,
          ...active.flatMap((range) => [
            Math.max(0, range.start - start),
            Math.min(value.length, range.end - start),
          ]),
        ]),
      ].sort((a, b) => a - b);
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < points.length - 1; index++) {
        const from = points[index],
          to = points[index + 1];
        const range = active.find(
          (range) => range.start <= start + from && range.end >= start + to,
        );
        const text = document.createTextNode(value.slice(from, to));
        if (range) {
          const mark = document.createElement("mark");
          mark.dataset.cwStart = String(range.start);
          mark.dataset.cwEnd = String(range.end);
          mark.append(text);
          fragment.append(mark);
        } else fragment.append(text);
      }
      node.replaceWith(fragment);
    }
    return body.innerHTML;
  }, [html, marks]);

  function capture(target: EventTarget | null) {
    const root = container.current;
    if (!root) return false;
    const selected = window.getSelection();
    if (selected?.rangeCount && !selected.isCollapsed) {
      const range = selected.getRangeAt(0);
      const raw = range.cloneContents().textContent || "";
      if (
        !root.contains(range.commonAncestorContainer) ||
        !raw.trim() ||
        raw.length > 5000
      ) {
        onSelection(null);
        return false;
      }
      const before = range.cloneRange();
      before.selectNodeContents(root);
      before.setEnd(range.startContainer, range.startOffset);
      const start = before.cloneContents().textContent?.length || 0;
      const rect = range.getBoundingClientRect();
      onSelection({
        start,
        end: start + raw.length,
        text: selected.toString(),
        x: rect.left,
        y: rect.bottom + 8,
      });
      return true;
    }
    const mark =
      target instanceof Element
        ? target.closest<HTMLElement>("[data-cw-start]")
        : null;
    if (mark && root.contains(mark)) {
      const start = Number(mark.dataset.cwStart),
        end = Number(mark.dataset.cwEnd);
      const rect = mark.getBoundingClientRect();
      onSelection({
        start,
        end,
        text: (root.textContent || "").slice(start, end),
        x: rect.left,
        y: rect.bottom + 8,
      });
      return true;
    }
    onSelection(null);
    return false;
  }
  return (
    <div
      className="rich-text cw-selectable-prompt"
      ref={container}
      onMouseUp={(event) => capture(event.target)}
      onKeyUp={(event) => {
        if (event.shiftKey) capture(event.target);
      }}
      onContextMenu={(event) => {
        if (capture(event.target)) event.preventDefault();
      }}
      dangerouslySetInnerHTML={{ __html: content }}
    />
  );
}
