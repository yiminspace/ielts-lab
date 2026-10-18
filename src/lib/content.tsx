import DOMPurify from "dompurify";
import type { StudyItem } from "../types";
export function textOf(value: unknown): string {
  if (value == null) return "";
  return String(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
export function mediaUrl(item: StudyItem, source?: string): string {
  if (!source) return "";
  const mapped = item.localMedia?.[source];
  if (mapped) return mapped;
  return source.startsWith("/media/") || source.startsWith("data:audio/")
    ? source
    : "";
}
export function RichText({
  html,
  className = "",
}: {
  html: unknown;
  className?: string;
}) {
  return (
    <div
      className={"rich-text " + className}
      dangerouslySetInnerHTML={{
        __html: DOMPurify.sanitize(String(html || ""), {
          FORBID_TAGS: ["style", "script", "iframe", "form", "input", "button"],
          FORBID_ATTR: ["style"],
          ALLOWED_URI_REGEXP:
            /^(?:\/(?!\/)|#|data:image\/(?:png|jpeg|webp);base64,)/i,
        }),
      }}
    />
  );
}
