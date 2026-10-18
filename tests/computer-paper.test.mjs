import test from "node:test";
import assert from "node:assert/strict";
import {
  paperParts,
  answersForPart,
  paperDraftKey,
  questionNavigation,
  questionNavigationEntries,
  navigationEntryProgress,
  navigationEntryMarked,
  validSession,
  paperReadingDeadline,
  remainingSeconds,
  advancePaperAudio,
  validatePaperParts,
} from "../src/lib/computer-test.mjs";
import { gradeGroups } from "../src/lib/questions.mjs";
function material(id, count = 10, kind = "listening", start = 1) {
  return {
    id,
    kind,
    title: id,
    collection: "Original test fixture",
    localMedia: {},
    data: {
      questions: [
        {
          questionJson: {
            questionType: "0",
            startIndex: start,
            endIndex: start + count - 1,
            questionNum: count,
            questionsContent: "<p>......</p>".repeat(count),
          },
          answerJson: Array.from({ length: count }, (_, index) => ({
            correctValue: `word${index}`,
          })),
        },
      ],
    },
  };
}
test("a whole listening paper maps four repeated local ranges to global 1–40 without answer-key collisions", () => {
  const items = ["one", "two", "three", "four"].map((id) => material(id));
  const parts = paperParts(items),
    groups = parts.flatMap((part) => part.groups);
  assert.deepEqual(
    questionNavigation(groups).map((nav) => nav.number),
    Array.from({ length: 40 }, (_, i) => i + 1),
  );
  assert.equal(
    new Set(groups.flatMap((group) => group.rows.map((row) => row.id))).size,
    40,
  );
  const answers = {
    [parts[0].groups[0].rows[0].id]: "first",
    [parts[1].groups[0].rows[0].id]: "second",
  };
  assert.deepEqual(answersForPart(parts[0], answers), { "0:0": "first" });
  assert.deepEqual(answersForPart(parts[1], answers), { "0:0": "second" });
  assert.equal(validatePaperParts(items, parts, "listening"), "");
  assert.equal(
    paperDraftKey("paper", "run", "listening"),
    "paper:paper:run:listening",
  );
  assert.notEqual(
    paperDraftKey("paper", "run", "reading"),
    paperDraftKey("paper", "run", "listening"),
  );
});
test("global numbering preserves multiple-choice answer slots and original per-part grading", () => {
  const multi = material("multi", 2);
  multi.data.questions = [
    {
      questionJson: {
        questionType: "2",
        startIndex: 21,
        endIndex: 22,
        questionNum: 2,
        questions: [
          {
            number: 2,
            content: "Choose two original options",
            options: [
              { content: "Option a" },
              { content: "Option b" },
              { content: "Option c" },
            ],
          },
        ],
      },
      answerJson: [{ correctValue: [0, 2] }],
    },
  ];
  const parts = paperParts([material("fill", 10, "listening", 11), multi]);
  const row = parts[1].groups[0].rows[0];
  assert.deepEqual([row.number, row.endNumber], [11, 12]);
  const answers = { [row.id]: ["2", "0"] };
  const allGroups = parts.flatMap((part) => part.groups);
  const entries = questionNavigationEntries(allGroups);
  const entry = entries.at(-1);
  assert.equal(entries.length, 11);
  assert.equal(questionNavigation(allGroups).length, 12);
  assert.equal(entry.label, "11–12");
  assert.equal(entry.rowId, row.id);
  assert.deepEqual(navigationEntryProgress(entry, row, answers), {
    answered: 2,
    total: 2,
    complete: true,
  });
  // Existing drafts already store one array under the row key, including a mark on the second slot.
  const restored = JSON.parse(
    JSON.stringify({
      version: 1,
      phase: "active",
      startedAt: 1,
      answers,
      marked: [12],
    }),
  );
  assert.equal(validSession(restored), true);
  assert.equal(navigationEntryMarked(entry, restored.marked), true);
  assert.deepEqual(answersForPart(parts[1], restored.answers), {
    "0:0": ["2", "0"],
  });
  assert.deepEqual(answersForPart(parts[1], answers), { "0:0": ["2", "0"] });
  assert.equal(
    gradeGroups(parts[1].originalGroups, answersForPart(parts[1], answers))
      .score,
    2,
  );
  assert.equal(gradeGroups(parts[1].groups, answers).score, 2);
});
test("reading uses one absolute 60-minute deadline across switches and reloads", () => {
  const startedAt = 100000;
  const saved = {
    startedAt,
    deadline: paperReadingDeadline(startedAt),
    viewedPart: 0,
  };
  const switched = { ...saved, viewedPart: 2 };
  const reloaded = JSON.parse(JSON.stringify(switched));
  assert.equal(reloaded.deadline, startedAt + 3600000);
  assert.equal(
    remainingSeconds(reloaded.deadline, startedAt + 30 * 60000),
    1800,
  );
  assert.equal(remainingSeconds(reloaded.deadline, startedAt + 2 * 3600000), 0);
  assert.equal(reloaded.deadline, paperReadingDeadline(reloaded.startedAt));
});
test("four recordings advance only on their own ended event, then add one persistent two-minute answer check", () => {
  let state = {
    audioIndex: 0,
    audioPosition: 19,
    audioEnded: false,
    deadline: null,
  };
  // Browsing another question part has no role in the audio transition.
  state = { ...state, viewedPart: 3 };
  assert.equal(advancePaperAudio(state, 3, 4, 10000), null);
  for (let index = 0; index < 3; index++) {
    state = {
      ...state,
      ...advancePaperAudio(state, index, 4, 10000 + index * 10000),
    };
    assert.equal(state.audioIndex, index + 1);
    assert.equal(state.audioPosition, 0);
    assert.equal(state.audioEnded, false);
    assert.equal(state.deadline, null);
  }
  state = { ...state, ...advancePaperAudio(state, 3, 4, 40000) };
  assert.equal(state.audioEnded, true);
  assert.equal(state.deadline, 160000);
  assert.equal(advancePaperAudio(state, 3, 4, 80000), null);
  const reloaded = JSON.parse(JSON.stringify(state));
  assert.equal(remainingSeconds(reloaded.deadline, 100000), 60);
  assert.equal(remainingSeconds(reloaded.deadline, 200000), 0);
});
test("audio failure or an incomplete paper cannot masquerade as a completed full paper", () => {
  const interrupted = {
    audioIndex: 1,
    audioPosition: 38.5,
    audioEnded: false,
    deadline: null,
  };
  assert.equal(advancePaperAudio(interrupted, 1, 4, 10000, false), null);
  assert.deepEqual(JSON.parse(JSON.stringify(interrupted)), interrupted);
  const missing = ["one", "two", "three"].map((id) => material(id));
  assert.match(
    validatePaperParts(missing, paperParts(missing), "listening"),
    /incomplete/,
  );
  const short = ["one", "two", "three"].map((id) => material(id, 6, "reading"));
  assert.match(
    validatePaperParts(short, paperParts(short), "reading"),
    /18 questions/,
  );
  assert.equal(
    validatePaperParts(short, paperParts(short), "reading", true),
    "",
  );
  const duplicated = [short[0], short[0], short[2]];
  assert.match(
    validatePaperParts(duplicated, paperParts(duplicated), "reading", true),
    /repeats/,
  );
});

test("global inline prefixes follow mapped gaps without rewriting quantities or unrelated text", async () => {
  const { renumberGapPrefixes } = await import("../src/lib/computer-test.mjs");
  const original = [4, 5, 6].map((number) => ({ number, slots: 1 }));
  const mapped = [10, 11, 12].map((number) => ({ number, slots: 1 }));
  const html =
    "<h3>4. Background facts</h3><p>4. Book before 16:00 on ...... .</p><p><strong>5.</strong> Pay 5.50 for ...... .</p><p>6. In 2026 report to ...... .</p><p>4. Do not renumber this unrelated list.</p>";
  assert.equal(
    renumberGapPrefixes(html, original, mapped),
    "<h3>4. Background facts</h3><p>10. Book before 16:00 on ...... .</p><p><strong>11.</strong> Pay 5.50 for ...... .</p><p>12. In 2026 report to ...... .</p><p>4. Do not renumber this unrelated list.</p>",
  );
  assert.equal(
    renumberGapPrefixes(
      "<p>4.5 metres from ......</p>",
      [{ number: 4, slots: 1 }],
      [{ number: 10, slots: 1 }],
    ),
    "<p>4.5 metres from ......</p>",
  );
  assert.equal(
    renumberGapPrefixes(
      "<p>The price is 4. Write ......</p>",
      [{ number: 4, slots: 1 }],
      [{ number: 10, slots: 1 }],
    ),
    "<p>The price is 4. Write ......</p>",
  );
  assert.equal(
    renumberGapPrefixes(
      "<p>4. A missing gap mapping ...... ......</p>",
      [{ number: 4, slots: 1 }],
      [{ number: 10, slots: 1 }],
    ),
    "<p>4. A missing gap mapping ...... ......</p>",
  );
});

test("original G demo reading sections render the same global prefixes as their answer controls", async () => {
  const { generalTrainingItems } =
    await import("../server/general-training.mjs");
  const reading = generalTrainingItems.filter(
    (item) => item.kind === "reading",
  );
  const parts = paperParts(reading);
  assert.match(parts[1].groups[1].content, /<p>10\. Make your booking/);
  assert.match(parts[1].groups[1].content, /<p>11\. If a bicycle/);
  assert.match(parts[1].groups[1].content, /<p>12\. Report/);
  assert.deepEqual(
    parts[1].groups[1].rows.map((row) => row.number),
    [10, 11, 12],
  );
  assert.match(parts[2].groups[1].content, /<p>16\. A belief/);
});
