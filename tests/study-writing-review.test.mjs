import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as study from "../src/lib/study.mjs";

const attempt = {
  id: "saved-writing",
  itemId: "letter",
  title: "Original letter",
  kind: "writing",
  createdAt: "2026-10-18T02:00:00.000Z",
  durationSeconds: 125,
  answers: {
    essay: "Dear manager, please change my booking.",
    notes: "A saved planning note.",
  },
};

test("writing history reads essay/text variants, preserves submitted blanks and excludes other items", () => {
  assert.deepEqual(study.writingReview("letter", attempt), {
    text: attempt.answers.essay,
    notes: attempt.answers.notes,
    words: 6,
    durationSeconds: 125,
    sharedTiming: false,
  });
  assert.equal(
    study.writingReview("letter", {
      ...attempt,
      answers: { text: "A legacy response" },
    }).text,
    "A legacy response",
  );
  assert.equal(
    study.writingReview("letter", {
      ...attempt,
      answers: { essay: "", text: "Do not use this fallback" },
    }).text,
    "",
  );
  assert.equal(study.writingReview("other", attempt), null);
  assert.equal(
    study.writingReview("letter", { ...attempt, kind: "reading" }),
    null,
  );
  assert.equal(
    study.writingReview("letter", { ...attempt, answers: {} }),
    null,
  );
  assert.equal(
    study.writingReview("letter", { ...attempt, durationSeconds: undefined })
      .durationSeconds,
    null,
  );
  assert.equal(
    study.writingReview("letter", {
      ...attempt,
      answers: { ...attempt.answers, paperRunId: "run" },
    }).sharedTiming,
    true,
  );
});

const code = ts.transpileModule(
  await readFile(
    new URL("../src/components/StudyWorkspace.tsx", import.meta.url),
    "utf8",
  ),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  },
).outputText;
const require = createRequire(import.meta.url);
function renderReview(reviewAttempt) {
  const calls = { draftReads: 0, writes: 0 };
  const context = vm.createContext({
    exports: {},
    require: (name) => {
      if (name === "../lib/progress")
        return {
          getProgress: () => {
            calls.draftReads++;
            return {
              drafts: {
                letter: { text: "Current unsaved study draft", seconds: 777 },
              },
            };
          },
          saveDraft: () => {
            calls.writes++;
          },
          recordAttempt: () => {
            calls.writes++;
          },
        };
      if (name === "../lib/study.mjs") return study;
      if (name === "../lib/content")
        return {
          RichText: ({ html }) => React.createElement("div", null, html),
          mediaUrl: () => "",
          textOf: String,
        };
      if (name.endsWith(".css")) return {};
      return require(name);
    },
  });
  vm.runInContext(code, context);
  const html = renderToStaticMarkup(
    React.createElement(context.exports.default, {
      item: {
        id: "letter",
        title: "Original letter",
        kind: "writing",
        collection: "Original",
        localMedia: {},
        data: { writingPart: 1, writingQuestion: "A letter prompt" },
      },
      reviewAttempt,
    }),
  );
  return { html, calls };
}

test("rendering historical writing uses read-only saved text and duration without reading the active draft or offering a timer", () => {
  const { html, calls } = renderReview(attempt);
  assert.match(html, /Dear manager, please change my booking/);
  assert.match(html, /A saved planning note/);
  assert.match(html, /02:05/);
  assert.match(html, /<strong>6<\/strong>/);
  assert.match(html, /readonly=""/i);
  assert.match(html, /导出本次作答/);
  assert.doesNotMatch(
    html,
    /Current unsaved study draft|开始计时|保存本次练习/,
  );
  assert.deepEqual(calls, { draftReads: 0, writes: 0 });
});

test("blank historical writing remains blank and ordinary entry still restores the study draft", () => {
  const history = renderReview({
    ...attempt,
    answers: { essay: "", notes: "" },
  });
  assert.match(history.html, /该次未填写作文/);
  assert.doesNotMatch(history.html, /Current unsaved study draft/);
  assert.equal(history.calls.draftReads, 0);
  const ordinary = renderReview(undefined);
  assert.match(ordinary.html, /Current unsaved study draft/);
  assert.match(ordinary.html, /开始计时/);
  assert.ok(ordinary.calls.draftReads > 0);
});
