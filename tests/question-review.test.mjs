import test from "node:test";
import assert from "node:assert/strict";
import { buildGroups } from "../src/lib/questions.mjs";
import {
  compactAnswer,
  completedBlankAnswer,
  resolveSolutionLine,
} from "../src/lib/question-review.mjs";

const lines = [
  { text: "The workshop starts on Tuesday." },
  { text: "Please meet at the northern entrance." },
  { text: "Bring a pencil and a notebook." },
];

test("review recording location accepts one-based indices and prioritizes a matching first phrase", () => {
  assert.equal(resolveSolutionLine({ sentenceList: [1] }, lines), 0);
  assert.equal(resolveSolutionLine({ sentenceList: ["3"] }, lines), 2);
  assert.equal(
    resolveSolutionLine(
      {
        sentenceList: [1],
        positionSentence: " ; NORTHERN entrance；Bring a pencil",
      },
      lines,
    ),
    1,
  );
  assert.equal(
    resolveSolutionLine(
      { sentenceList: [2], positionSentence: "Missing phrase\nBring a pencil" },
      lines,
    ),
    1,
    "Only the first nonempty saved phrase participates; an unmatched phrase preserves a valid index",
  );
});

test("review recording location rejects invalid indices without losing a valid phrase fallback", () => {
  for (const index of [0, -1, 1.5, 4, "", "bad", null, true, Infinity])
    assert.equal(resolveSolutionLine({ sentenceList: [index] }, lines), -1);
  assert.equal(resolveSolutionLine({}, lines), -1);
  assert.equal(resolveSolutionLine(null, lines), -1);
  assert.equal(resolveSolutionLine({ sentenceList: "2" }, lines), -1);
  assert.equal(resolveSolutionLine({ sentenceList: [1] }, []), -1);
  assert.equal(resolveSolutionLine({ sentenceList: [1] }, undefined), -1);
  assert.equal(
    resolveSolutionLine(
      { sentenceList: [999], positionSentence: "bring a pencil" },
      lines,
    ),
    2,
  );
});

function blank(expected) {
  return buildGroups({
    questions: [
      {
        questionJson: { questionType: "0", questionNum: 1 },
        answerJson: [{ correctValue: expected }],
      },
    ],
  })[0].rows[0];
}

test("single blanks show one accepted spelling and retain all other variants", () => {
  assert.deepEqual(compactAnswer(blank("theatre/theater")), {
    primary: "theatre",
    alternatives: ["theater"],
  });
  assert.deepEqual(compactAnswer(blank(" 120 / one hundred twenty /120/")), {
    primary: "120",
    alternatives: ["one hundred twenty"],
  });
  assert.deepEqual(compactAnswer(blank("north")), {
    primary: "north",
    alternatives: [],
  });
  assert.deepEqual(compactAnswer(blank(undefined)), {
    primary: "",
    alternatives: [],
  });
});

test("two blanks and ambiguous compound keys preserve the complete shared answer", () => {
  assert.deepEqual(compactAnswer(blank("morning|evening/night")), {
    primary: "morning + evening/night",
    alternatives: [],
  });
  assert.deepEqual(compactAnswer(blank("times|dates/dates|times")), {
    primary: "times + dates/dates + times",
    alternatives: [],
  });
});

test("choice and judgment labels are never split into spelling alternatives", () => {
  const row = {
    ...blank("0"),
    type: "3",
    options: [{ value: "0", label: "A", content: "TRUE / YES" }],
  };
  assert.deepEqual(compactAnswer(row), {
    primary: "TRUE / YES",
    alternatives: [],
  });
});

test("completed single blanks use one accepted spelling without inserting every alternative", () => {
  assert.equal(completedBlankAnswer(blank("  theatre / theater  ")), "theatre");
  assert.equal(completedBlankAnswer(blank("/ 120 / one hundred twenty /")), "120");
  assert.equal(completedBlankAnswer(blank("North Gate")), "North Gate");
});

test("completed blank text never assigns an unordered pair or option key to a sentence slot", () => {
  assert.equal(completedBlankAnswer(blank("morning|evening/night")), null);
  assert.equal(completedBlankAnswer(blank("times|dates/dates|times")), null);
  const single = blank("north");
  for (const type of ["1", "2", "3", "4", "unknown"])
    assert.equal(completedBlankAnswer({ ...single, type }), null);
  assert.equal(completedBlankAnswer({ ...single, slots: 2 }), null);
  assert.equal(completedBlankAnswer({ ...single, supported: false }), null);
});

test("completed blanks require a nonempty text answer instead of coercing malformed keys", () => {
  for (const expected of [
    undefined,
    null,
    "",
    "   ",
    "/",
    " / / ",
    120,
    ["north"],
    {},
  ])
    assert.equal(completedBlankAnswer(blank(expected)), null);
});
