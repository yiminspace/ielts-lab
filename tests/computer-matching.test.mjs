import test from "node:test";
import assert from "node:assert/strict";
import { buildGroups, gradeGroups } from "../apps/web/src/lib/questions.mjs";
import {
  matchingMatrix,
  paperParts,
  answersForPart,
} from "../apps/web/src/lib/computer-test.mjs";

// Original examples exercise the observed interaction structure, not official questions.
function question(
  description = "Which notice contains the following information? You may use a letter more than once.",
) {
  return {
    questionJson: {
      questionType: "4",
      startIndex: 1,
      endIndex: 2,
      questionNum: 2,
      descriptions: description,
      questionsContent:
        "<p>1. <strong>Bring a card</strong> to register. ......</p>\n<p>2. Weekend bookings are accepted. ......</p>",
      matchOptions: ["Workshop", "Studio", "Library"].map((content, index) => ({
        index: "ABC"[index],
        content,
      })),
    },
    answerJson: [{ correctValue: 0 }, { correctValue: 0 }],
  };
}
const group = (raw) => buildGroups({ questions: [raw] })[0];

test("explicit information matching produces one rich statement per radio row without consulting answers", () => {
  const raw = question(),
    source = group(raw),
    matrix = matchingMatrix(source);
  assert.equal(matrix.kind, "information");
  assert.deepEqual(
    matrix.options.map((option) => option.label),
    ["A", "B", "C"],
  );
  assert.deepEqual(
    matrix.rows.map((row) => row.rowId),
    source.rows.map((row) => row.id),
  );
  assert.equal(
    matrix.rows[0].html,
    "<strong>Bring a card</strong> to register. ",
  );
  assert.equal(matrix.rows[0].beforeHtml, "<p>1. ");
  assert.equal(
    matrix.rows[1].beforeHtml,
    "<p>1. <strong>Bring a card</strong> to register. ......</p>\n<p>2. ",
  );
  assert.equal(
    matrix.rows.some((row) => row.html.includes("......")),
    false,
  );
  const noAnswers = {
    ...source,
    rows: source.rows.map((row) => ({
      ...row,
      expected: null,
      solution: {},
      supported: false,
    })),
  };
  assert.deepEqual(matchingMatrix(noAnswers), matrix);
});

test("a notice question phrased as true statements is recognized from its instructions", () => {
  const source = group(
    question(
      "Look at the three community notices A–C. For which venue are the following statements true? You may choose any letter more than once.",
    ),
  );
  assert.equal(matchingMatrix(source).kind, "information");
});

test("explicit features matching keeps the separate option list and permits the same value on two rows", () => {
  const raw = question(
    "Choose the correct venue, A–C, for each statement. You may choose any venue more than once.",
  );
  raw.questionJson.optionsTitle = "List of venues";
  const source = group(raw),
    matrix = matchingMatrix(source);
  assert.equal(matrix.kind, "features");
  assert.deepEqual(
    matrix.options.map((option) => option.content),
    ["Workshop", "Studio", "Library"],
  );
  const answers = Object.fromEntries(source.rows.map((row) => [row.id, "0"]));
  assert.equal(gradeGroups([source], answers).score, 2);
});

test("uncertain semantics, Roman headings and ambiguous statement layouts retain the existing control", () => {
  for (const description of [
    "Match the statements with the options.",
    "Which notice contains the following information?",
    "Choose the correct headings for each statement. You may use a letter more than once.",
    "Match each sentence ending. You may choose any letter more than once.",
  ])
    assert.equal(matchingMatrix(group(question(description))), null);
  const roman = group(question());
  roman.rows.forEach((row) =>
    row.options.forEach((option, index) => {
      option.label = ["i", "ii", "iii"][index];
    }),
  );
  assert.equal(matchingMatrix(roman), null);
  for (const content of [
    "<p>Important extra context</p><p>1. First ......</p><p>2. Second ......</p>",
    "<p>1. First ...... and second ......</p>",
    "<p>1. First ......</p><p>3. Unexpected numbering ......</p>",
    "<table><tr><td>1. First ......</td><td>2. Second ......</td></tr></table>",
  ]) {
    const raw = question();
    raw.questionJson.questionsContent = content;
    assert.equal(matchingMatrix(group(raw)), null);
  }
});

test("matrix rows use full-paper numbers while preserving old answer keys and repeated selections", () => {
  const prefix = {
    id: "intro",
    kind: "reading",
    data: {
      questions: [
        {
          questionJson: {
            questionType: "0",
            startIndex: 1,
            questionNum: 3,
            questionsContent: "<p>......</p>".repeat(3),
          },
          answerJson: ["one", "two", "three"].map((correctValue) => ({
            correctValue,
          })),
        },
      ],
    },
  };
  const item = {
    id: "matrix",
    kind: "reading",
    data: { questions: [question()] },
  };
  const part = paperParts([prefix, item])[1],
    source = part.groups[0];
  const matrix = matchingMatrix(source);
  assert.deepEqual(
    source.rows.map((row) => row.number),
    [4, 5],
  );
  assert.equal(matrix.rows[0].beforeHtml, "<p>4. ");
  const answers = Object.fromEntries(source.rows.map((row) => [row.id, "0"]));
  assert.deepEqual(answersForPart(part, answers), { "0:0": "0", "0:1": "0" });
  assert.equal(
    gradeGroups(part.originalGroups, answersForPart(part, answers)).score,
    2,
  );
});

test("verified matching instructions accept ordinary information and feature wording variants", () => {
  for (const [prompt, kind] of [
    ["Which paragraph mentions the following?", "information"],
    ["Which section contains the following details?", "information"],
    ["For which company are the following statements true?", "features"],
    ["Match each statement with the correct person.", "features"],
    ["Match each project with the correct researcher.", "features"],
    ["Match each statement with the correct organisation.", "features"],
  ]) {
    const matrix = matchingMatrix(
      group(question(`${prompt} You may use a letter more than once.`)),
    );
    assert.equal(matrix?.kind, kind, prompt);
    assert.equal(matrix.rows.length, 2);
  }
});

test("empty paragraphs do not become questions and retain their original highlight offsets", () => {
  const raw = question();
  raw.questionJson.questionsContent =
    "<p> &nbsp;<br></p><p>1. First statement ......</p><p><span> </span></p><p>2. Second statement ......</p><p></p>";
  const matrix = matchingMatrix(group(raw));
  assert.equal(matrix.rows.length, 2);
  assert.equal(matrix.rows[0].html, "First statement ");
  assert.equal(matrix.rows[0].beforeHtml, "<p> &nbsp;<br></p><p>1. ");
  assert.equal(
    matrix.rows[1].beforeHtml,
    "<p> &nbsp;<br></p><p>1. First statement ......</p><p><span> </span></p><p>2. ",
  );
  raw.questionJson.questionsContent =
    '<p><img src="/media/context.png"></p><p>1. First ......</p><p>2. Second ......</p>';
  assert.equal(
    matchingMatrix(group(raw)),
    null,
    "An image-only paragraph is context, not blank",
  );
  raw.questionJson.questionsContent =
    "<h3>Extra context</h3><p>1. First ......</p><p>2. Second ......</p>";
  assert.equal(matchingMatrix(group(raw)), null);
  raw.questionJson.questionsContent =
    "<div>1. First ......</div><div>2. Second ......</div>";
  assert.equal(matchingMatrix(group(raw)), null);
});
