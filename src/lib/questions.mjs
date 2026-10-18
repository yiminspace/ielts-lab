/** Original adapters for the five observed archive schemas; no platform code is included. */
export const QUESTION_TYPES = {
  0: "填空",
  1: "单项选择",
  2: "多项选择",
  3: "判断",
  4: "匹配",
};
export function normalizeAnswer(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/[‘’]/g, "'")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
function parse(value, fallback) {
  if (typeof value !== "string") return value ?? fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
export function optionLabel(option, index, indexType) {
  if (option?.index != null && String(option.index).trim())
    return String(option.index);
  if (indexType === "roma")
    return (
      [
        "i",
        "ii",
        "iii",
        "iv",
        "v",
        "vi",
        "vii",
        "viii",
        "ix",
        "x",
        "xi",
        "xii",
        "xiii",
        "xiv",
        "xv",
        "xvi",
        "xvii",
        "xviii",
        "xix",
        "xx",
      ][index] || String(index + 1)
    );
  return String.fromCharCode(65 + index);
}
export function buildGroups(input) {
  const data = input?.data?.questions ? input.data : input;
  let fallbackStart = 1;
  return (Array.isArray(data?.questions) ? data.questions : []).map(
    (raw, gi) => {
      const q = parse(raw.questionJson, {});
      const solutions = parse(raw.answerJson, []);
      const type = String(q.questionType ?? raw.questionType ?? "unknown");
      const start = Number(q.startIndex) || fallbackStart;
      const count =
        Number(q.questionNum || raw.questionCount) ||
        solutions.length ||
        q.questions?.length ||
        1;
      const end = Number(q.endIndex) || start + count - 1;
      fallbackStart = end + 1;
      const shared = Array.isArray(q.matchOptions) ? q.matchOptions : [];
      const sourceRows = ["1", "2", "3"].includes(type)
        ? q.questions || []
        : Array.from({ length: Math.max(solutions.length, count) }, () => ({}));
      let nextNumber = start;
      const rows = sourceRows.map((row, ri) => {
        const expected = solutions[ri]?.correctValue;
        const weight =
          type === "2"
            ? Number(row.number) ||
              (Array.isArray(expected) ? expected.length : count)
            : 1;
        const number = nextNumber;
        nextNumber += weight;
        const options = (type === "4" ? shared : row.options || []).map(
          (o, oi) => ({
            value: String(oi),
            label: optionLabel(o, oi, q.indexType),
            content: o.content || "",
          }),
        );
        const compound =
          type === "0" &&
          typeof expected === "string" &&
          expected.includes("|");
        // Only one unambiguous pair separator is automatically assessed.
        const parts = compound ? expected.split("|").length : 1;
        return {
          id: `${gi}:${ri}`,
          number,
          endNumber: number + weight - 1,
          type,
          content: row.content || "",
          options,
          expected,
          weight,
          slots: compound && parts === 2 ? 2 : 1,
          solution: solutions[ri] || {},
          supported:
            Object.hasOwn(QUESTION_TYPES, type) &&
            expected != null &&
            (!compound || parts === 2),
        };
      });
      return {
        id: String(gi),
        type,
        title: QUESTION_TYPES[type] || "待人工核对题型",
        start,
        end,
        count,
        description: q.descriptions || "",
        content: q.questionsContent || "",
        image: q.questionsImgSrc || "",
        optionsImage: q.optionsImgSrc || "",
        optionsTitle: q.optionsTitle || "",
        rows,
        raw: q,
      };
    },
  );
}
function onePart(user, expected) {
  return String(expected)
    .split("/")
    .map(normalizeAnswer)
    .filter(Boolean)
    .includes(normalizeAnswer(user));
}
export function assessRow(row, answer) {
  if (!row.supported)
    return {
      status: "manual",
      earned: 0,
      total: row.weight,
      reason: "该答案结构需要人工核对",
    };
  if (row.type === "0") {
    const expectedParts = String(row.expected).split("|");
    const actualParts = Array.isArray(answer)
      ? answer
      : String(answer ?? "").split("|");
    const isEmpty = actualParts.every((v) => !normalizeAnswer(v));
    let correct;
    if (expectedParts.length === 2)
      correct =
        actualParts.length === 2 &&
        ((onePart(actualParts[0], expectedParts[0]) &&
          onePart(actualParts[1], expectedParts[1])) ||
          (onePart(actualParts[0], expectedParts[1]) &&
            onePart(actualParts[1], expectedParts[0])));
    else correct = onePart(actualParts.join("|"), row.expected);
    return {
      status: isEmpty ? "blank" : correct ? "correct" : "incorrect",
      earned: correct ? 1 : 0,
      total: 1,
    };
  }
  if (row.type === "2") {
    if (
      !Array.isArray(row.expected) ||
      row.expected.length !== row.weight ||
      row.expected.some((v) => !row.options.some((o) => o.value === String(v)))
    )
      return {
        status: "manual",
        earned: 0,
        total: row.weight,
        reason: "多选答案与题目数量不一致",
      };
    const selected = [
      ...new Set(
        (Array.isArray(answer)
          ? answer
          : answer === "" || answer == null
            ? []
            : [answer]
        ).map(String),
      ),
    ];
    // A selection exceeding the permitted count never earns credit.
    const earned =
      selected.length <= row.weight
        ? selected.filter((v) => row.expected.map(String).includes(v)).length
        : 0;
    return {
      status: !selected.length
        ? "blank"
        : earned === row.weight
          ? "correct"
          : earned > 0
            ? "partial"
            : "incorrect",
      earned,
      total: row.weight,
    };
  }
  const expected = String(row.expected);
  if (!row.options.some((o) => o.value === expected))
    return {
      status: "manual",
      earned: 0,
      total: row.weight,
      reason: "标准答案未对应可见选项",
    };
  const empty = answer == null || answer === "" || Array.isArray(answer);
  const correct = !empty && String(answer) === expected;
  return {
    status: empty ? "blank" : correct ? "correct" : "incorrect",
    earned: correct ? 1 : 0,
    total: 1,
  };
}
export function gradeGroups(groups, answers) {
  const results = groups.flatMap((g) =>
    g.rows.map((row) => ({
      id: row.id,
      number: row.number,
      ...assessRow(row, answers[row.id]),
    })),
  );
  return {
    results,
    score: results.reduce((n, r) => n + r.earned, 0),
    total: results.reduce((n, r) => n + r.total, 0),
    manual: results
      .filter((r) => r.status === "manual")
      .reduce((n, r) => n + r.total, 0),
  };
}
export function displayAnswer(row, value = row.expected) {
  if (row.type === "0")
    return Array.isArray(value)
      ? value.join(" · ")
      : String(value ?? "").replace(/\|/g, " + ");
  return (Array.isArray(value) ? value : [value])
    .map((v) => {
      const o = row.options.find((x) => x.value === String(v));
      return o ? (row.type === "3" ? o.content : o.label) : String(v ?? "");
    })
    .join(", ");
}
export function parseTranscript(value, totalSeconds = 0) {
  if (typeof value !== "string") return [];
  const lines = value
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*\[(\d+):(\d+(?:\.\d+)?)\](.*)$/);
      if (!match) return null;
      const [text, ...translation] = match[3].split("##");
      return {
        start: Number(match[1]) * 60 + Number(match[2]),
        text: text.trim(),
        translation: translation.join("##").trim(),
      };
    })
    .filter(Boolean);
  return lines
    .map((line, i) => ({
      ...line,
      end:
        lines[i + 1]?.start ??
        (totalSeconds > line.start ? totalSeconds : line.start + 12),
    }))
    .filter((line) => line.text);
}
export function answerQuotes(solution) {
  const highlights = solution?.articleSourceHighlight;
  const data = parse(highlights, {})?.data;
  if (!Array.isArray(data)) return [];
  return [
    ...new Set(
      data.flatMap((part) =>
        Object.values(part || {})
          .map((value) => value?.text)
          .filter(Boolean),
      ),
    ),
  ];
}
