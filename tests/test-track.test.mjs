import test from "node:test";
import assert from "node:assert/strict";
import { classifyTestTrack, matchesTestTrack } from "../apps/web/src/lib/test-track.mjs";

test("explicit track metadata and category labels identify A/G without guessing from Cambridge", () => {
  assert.equal(
    classifyTestTrack({ kind: "reading", title: "IELTS Academic Reading" }),
    "academic",
  );
  assert.equal(
    classifyTestTrack({ kind: "writing", collection: "G 类原创练习" }),
    "general",
  );
  assert.equal(
    classifyTestTrack({ kind: "reading" }, { examType: "General Training" }),
    "general",
  );
  assert.equal(
    classifyTestTrack(
      { kind: "writing" },
      { declaredCollection: { title: "学术类" } },
    ),
    "academic",
  );
  for (const metadata of [
    { examType: 0 },
    { examType: "1" },
    { writingPart: 1 },
    { writingPart: 2 },
  ])
    assert.equal(
      classifyTestTrack(
        { kind: "reading", title: "C21 Test 1", collection: "Cambridge IELTS" },
        metadata,
      ),
      "unclassified",
    );
});

test("essay topics, question text and conflicting evidence cannot silently assign a track", () => {
  for (const title of [
    "Academic freedom",
    "General knowledge",
    "A guide to reading",
    "Writing a letter",
  ])
    assert.equal(classifyTestTrack({ kind: "writing", title }), "unclassified");
  assert.equal(
    classifyTestTrack(
      { kind: "reading" },
      {
        passagesContent: "IELTS Academic Reading",
        writingQuestion: "General Training",
      },
    ),
    "unclassified",
  );
  assert.equal(
    classifyTestTrack({
      kind: "reading",
      title: "General Training",
      collection: "Academic Reading",
    }),
    "unclassified",
  );
  assert.equal(
    classifyTestTrack(
      { kind: "writing", testTrack: "academic" },
      { examType: "general" },
    ),
    "unclassified",
  );
});

test("shared skills appear in A/G views while unknown or contradictory items remain in all", () => {
  for (const kind of [
    "listening",
    "speaking",
    "vocabulary",
    "sentences",
    "grammar",
    "numbers",
    "typing",
    "courses",
  ]) {
    assert.equal(classifyTestTrack({ kind }), "shared");
    assert.equal(matchesTestTrack({ kind }, "academic"), true);
    assert.equal(matchesTestTrack({ kind }, "general"), true);
  }
  assert.equal(
    matchesTestTrack({ kind: "reading", testTrack: "general" }, "academic"),
    false,
  );
  assert.equal(
    matchesTestTrack({ kind: "reading", testTrack: "general" }, "general"),
    true,
  );
  const unknown = {
    kind: "reading",
    testTrack: "unclassified",
    title: "Academic Reading",
  };
  assert.equal(matchesTestTrack(unknown, "academic"), false);
  assert.equal(matchesTestTrack(unknown, "general"), false);
  assert.equal(matchesTestTrack(unknown, "all"), true);
  assert.equal(matchesTestTrack(unknown, "unclassified"), true);
});
