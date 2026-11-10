import type { ClipboardEvent } from "react";

// CSS user-select alone does not reliably exclude controls between selected rows.
export function copyTranscript(event: ClipboardEvent<HTMLDivElement>) {
  const root = event.currentTarget;
  const selection = root.ownerDocument.getSelection();
  if (
    !selection ||
    selection.isCollapsed ||
    !root.contains(selection.anchorNode) ||
    !root.contains(selection.focusNode)
  )
    return;

  const parts: string[] = [];
  for (let i = 0; i < selection.rangeCount; i++) {
    const selected = selection.getRangeAt(i);
    for (const source of root.querySelectorAll("[data-transcript-source]")) {
      if (!selected.intersectsNode(source)) continue;
      const overlap = root.ownerDocument.createRange();
      overlap.selectNodeContents(source);
      if (selected.compareBoundaryPoints(Range.START_TO_START, overlap) > 0)
        overlap.setStart(selected.startContainer, selected.startOffset);
      if (selected.compareBoundaryPoints(Range.END_TO_END, overlap) < 0)
        overlap.setEnd(selected.endContainer, selected.endOffset);
      const text = overlap.toString();
      if (text) parts.push(text);
    }
  }
  // Keep ordinary copying for transcripts without a sentence timeline.
  if (!root.querySelector("[data-transcript-source]")) return;
  event.clipboardData.setData("text/plain", parts.join("\n"));
  event.preventDefault();
}
