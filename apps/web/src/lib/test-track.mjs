const sharedKinds = new Set([
  "listening",
  "speaking",
  "vocabulary",
  "sentences",
  "grammar",
  "numbers",
  "typing",
  "courses",
]);
const tracks = new Set(["academic", "general", "shared", "unclassified"]);

function labelTracks(value) {
  if (typeof value !== "string") return [];
  const text = value.trim();
  const result = [];
  if (
    /(?:学术类|(?:^|[^a-z])a\s*类)/i.test(text) ||
    /^academic$/i.test(text) ||
    /\bacademic\s+(?:reading|writing|test|practice)\b/i.test(text) ||
    /\b(?:ielts|cambridge)\b.{0,30}\bacademic\b/i.test(text)
  )
    result.push("academic");
  if (
    /(?:培训类|(?:^|[^a-z])g\s*类)/i.test(text) ||
    /\bgeneral[\s-]+training\b/i.test(text) ||
    /\bgt[\s_-]+(?:reading|writing|test|practice)\b/i.test(text)
  )
    result.push("general");
  return result;
}

/** Return explicit evidence so archive catalog conflicts are not mistaken for absence. */
export function testTrackEvidence(item, metadata = {}) {
  if (sharedKinds.has(item?.kind)) return ["shared"];
  if (item?.kind !== "reading" && item?.kind !== "writing") return [];
  const evidence = new Set();
  for (const record of [item, metadata]) {
    if (!record || typeof record !== "object") continue;
    for (const key of [
      "testTrack",
      "examTrack",
      "testType",
      "examType",
      "paperType",
    ]) {
      const value = record[key];
      // Numeric enums are deliberately not universal: archive catalog links
      // establish their meaning without guessing another producer's convention.
      if (typeof value !== "string") continue;
      const canonical = value.trim().toLowerCase();
      if (tracks.has(canonical) && canonical !== "unclassified")
        evidence.add(canonical);
      else for (const track of labelTracks(value)) evidence.add(track);
    }
    for (const value of [
      record.title,
      record.collection,
      record.category,
      record.declaredCollection?.title,
    ])
      for (const track of labelTracks(value)) evidence.add(track);
  }
  return [...evidence];
}

/** Classify only explicit track labels, never question text, book number or part. */
export function classifyTestTrack(item, metadata = {}) {
  const evidence = testTrackEvidence(item, metadata);
  return evidence.length === 1 ? evidence[0] : "unclassified";
}

/** Shared skills are included in A/G views; uncertain reading/writing stay in all. */
export function matchesTestTrack(item, requested = "all") {
  if (requested === "all") return true;
  const track = tracks.has(item?.testTrack)
    ? item.testTrack
    : classifyTestTrack(item);
  return (
    track === requested ||
    (track === "shared" && ["academic", "general"].includes(requested))
  );
}
