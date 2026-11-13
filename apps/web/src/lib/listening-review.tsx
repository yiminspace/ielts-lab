export type ListeningEvidence = {
  line: number;
  quotes: string[];
  answer: string;
  kind: "correct" | "distractor";
  explanation: string;
};

export type ListeningReview = {
  evidence: ListeningEvidence[];
  unmentioned: string[];
};

export function TranscriptEvidence({
  text,
  evidence,
}: {
  text: string;
  evidence: ListeningEvidence[];
}) {
  const ranges = evidence.flatMap(({ quotes, kind }) =>
    quotes.flatMap((quote) => {
      const start = text.indexOf(quote);
      return start >= 0 && quote.length > 0
        ? [{ start, end: start + quote.length, kind }]
        : [];
    }),
  );
  if (!ranges.length) return text;
  const edges = [
    ...new Set([
      0,
      text.length,
      ...ranges.flatMap(({ start, end }) => [start, end]),
    ]),
  ].sort((a, b) => a - b);
  return edges.slice(0, -1).map((start, i) => {
    const end = edges[i + 1];
    const matches = ranges.filter(
      (range) => range.start <= start && range.end >= end,
    );
    const content = text.slice(start, end);
    if (!matches.length) return content;
    const kind = matches.some((range) => range.kind === "correct")
      ? "correct"
      : "distractor";
    return (
      <u key={start} className={`exam-evidence-quote ${kind}`}>
        {content}
      </u>
    );
  });
}
