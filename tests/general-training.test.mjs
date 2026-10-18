import test from "node:test";
import assert from "node:assert/strict";
import { generalTrainingItems } from "../server/general-training.mjs";
import {
  answerQuotes,
  buildGroups,
  gradeGroups,
  normalizeAnswer,
} from "../src/lib/questions.mjs";

const readings = generalTrainingItems.filter((item) => item.kind === "reading");
const writings = generalTrainingItems.filter((item) => item.kind === "writing");
// Independent answer sheets also check the adapter's zero-based option values.
const answerSheets = {
  "general-reading-section-1": ["0", "2", "1", "7", "apron", "green"],
  "general-reading-section-2": [
    "1",
    "0",
    "2",
    "intranet",
    "defect",
    "security",
  ],
  "general-reading-section-3": ["1", "2", "0", "2", "0", "5"],
};

test("G starter pack identifies all seven original items without claiming a full test", () => {
  assert.equal(generalTrainingItems.length, 7);
  assert.equal(new Set(generalTrainingItems.map((item) => item.id)).size, 7);
  assert.equal(readings.length, 3);
  assert.equal(writings.length, 4);
  for (const item of generalTrainingItems) {
    assert.match(item.id, /^general-/);
    assert.equal(item.testTrack, "general");
    assert.equal(item.source, "original");
    assert.equal(item.collection, "G 类原创练习");
    assert.match(item.description, /非官方真题或完整模拟考试/);
    assert.deepEqual(item.localMedia, {});
  }
});

test("each G reading normalizes to six numbered marks and grades its independent answer sheet", () => {
  for (const item of readings) {
    const groups = buildGroups(item);
    const rows = groups.flatMap((group) => group.rows);
    assert.equal(item.count, 6);
    assert.deepEqual(
      rows.map((row) => row.number),
      [1, 2, 3, 4, 5, 6],
    );
    assert.equal(
      rows.every((row) => row.supported),
      true,
    );
    const responses = Object.fromEntries(
      rows.map((row, index) => [row.id, answerSheets[item.id][index]]),
    );
    const graded = gradeGroups(groups, responses);
    assert.equal(graded.total, 6, item.id);
    assert.equal(graded.score, 6, item.id);
    assert.equal(graded.manual, 0, item.id);
    assert.ok(graded.results.every((result) => result.status === "correct"));
    const blank = gradeGroups(groups, {});
    assert.equal(blank.score, 0);
    assert.ok(blank.results.every((result) => result.status === "blank"));
    const wrong = gradeGroups(
      groups,
      Object.fromEntries(rows.map((row) => [row.id, "__wrong__"])),
    );
    assert.equal(wrong.score, 0);
    assert.equal(wrong.manual, 0);
  }
});

test("reading questions retain prompts and explanations, and cited evidence occurs in their own text", () => {
  const minimumLengths = { 1: 350, 2: 450, 3: 600 };
  for (const item of readings) {
    const passage = normalizeAnswer(item.data.passagesContent);
    assert.ok(
      passage.split(/\s+/).length >= minimumLengths[item.data.part],
      item.id,
    );
    for (const group of buildGroups(item)) {
      if (["0", "4"].includes(group.type)) assert.ok(group.content.trim());
      for (const row of group.rows) {
        assert.ok(row.solution.explain.trim());
        if (["1", "3"].includes(group.type)) {
          assert.ok(row.content.trim());
          assert.ok(row.options.length >= 3);
        }
        const evidence = answerQuotes(row.solution);
        // NOT GIVEN is deliberately explained by missing information, not an invented quote.
        if (row.type === "3" && row.expected === 2) {
          assert.equal(evidence.length, 0);
          assert.match(row.solution.explain, /未说明/);
        } else {
          assert.ok(evidence.length, `${item.id} question ${row.number}`);
          for (const quote of evidence)
            assert.ok(passage.includes(normalizeAnswer(quote)));
        }
      }
    }
  }
});

test("G matching statements each retain one inline answer placeholder beside their own number", () => {
  const matchingGroups = readings
    .flatMap((item) => buildGroups(item))
    .filter((group) => group.type === "4");
  assert.equal(matchingGroups.length, 2);
  for (const group of matchingGroups) {
    const statements = [...group.content.matchAll(/<p>(.*?)<\/p>/g)].map(
      (match) => match[1],
    );
    assert.equal(statements.length, group.rows.length);
    for (const [index, row] of group.rows.entries()) {
      assert.ok(statements[index].startsWith(`${row.number}. `));
      assert.equal((statements[index].match(/\.{6}/g) || []).length, 1);
      assert.ok(statements[index].endsWith(" ......"));
    }
  }
});

test("Task 1 provides three distinct letter registers with three bullet points and correct practice guidance", () => {
  const letters = writings.filter((item) => item.data.writingPart === 1);
  assert.deepEqual(letters.map((item) => item.data.letterRegister).sort(), [
    "formal",
    "informal",
    "semi-formal",
  ]);
  for (const item of letters) {
    const data = item.data;
    assert.equal(data.writingGenre, "letter");
    assert.equal(data.minimumWords, 150);
    assert.equal(data.recommendedMinutes, 20);
    assert.equal(data.hasSample, false);
    assert.equal((data.writingQuestion.match(/<li>/g) || []).length, 3);
    assert.match(data.writingQuestion, /20 minutes/);
    assert.match(data.writingQuestion, /at least 150 words/);
    assert.match(data.writingQuestion, /Begin your letter/);
    assert.match(data.writingQuestionText, /Write a letter/);
  }
});

test("G Task 2 uses an essay prompt with its own duration and word minimum", () => {
  const essays = writings.filter((item) => item.data.writingPart === 2);
  assert.equal(essays.length, 1);
  const { data } = essays[0];
  assert.equal(data.writingGenre, "essay");
  assert.equal(data.minimumWords, 250);
  assert.equal(data.recommendedMinutes, 40);
  assert.equal(data.hasSample, false);
  assert.match(data.writingQuestion, /40 minutes/);
  assert.match(data.writingQuestion, /at least 250 words/);
  assert.match(
    data.writingQuestion,
    /Discuss both views and give your own opinion/,
  );
});
