import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as study from "../apps/web/src/lib/study.mjs";
import * as writingUi from "../apps/web/src/lib/computer-writing-ui.mjs";

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
    new URL("../apps/web/src/components/StudyWorkspace.tsx", import.meta.url),
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
function renderReview(reviewAttempt, savedDraft = {}) {
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
                letter: {
                  text: "Current unsaved study draft",
                  seconds: 777,
                  ...savedDraft,
                },
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
      if (name === "../lib/computer-writing-ui.mjs") return writingUi;
      if (name === "../lib/runtime") return {};
      if (name === "../lib/recordings") return {};
      if (name === "./SpeakingRecordings") return { default: () => null };
      if (name === "./PracticeFrame")
        return {
          default: ({
            status,
            instruction,
            actions,
            tools,
            children,
            footer,
          }) =>
            React.createElement(
              "main",
              null,
              status,
              instruction,
              actions,
              tools,
              children,
              footer,
            ),
        };
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

test("invalid or mismatched history never falls back to the current writing draft", () => {
  for (const reviewAttempt of [
    { ...attempt, answers: {} },
    { ...attempt, itemId: "another-item" },
  ]) {
    const { html, calls } = renderReview(reviewAttempt);
    assert.match(html, /这条历史记录没有可复盘的作文/);
    assert.doesNotMatch(html, /Current unsaved study draft|开始计时|完成练习/);
    assert.deepEqual(calls, { draftReads: 0, writes: 0 });
  }
});

test("reopening a completed practice keeps its response read-only until continuing to edit", () => {
  const { html } = renderReview(undefined, { practiceStatus: "completed" });
  assert.match(html, /Current unsaved study draft/);
  assert.match(html, /readonly=""/i);
  assert.match(html, /继续编辑/);
  assert.match(html, /本次作答已保存/);
  assert.doesNotMatch(html, /开始计时|完成练习|保存本次练习/);
});

test("finishing writing records once, snapshots notes, and preserves the separate exam draft", () => {
  const progress = {
    drafts: {
      letter: { text: "My first response", seconds: 50 },
      "exam:letter": { text: "Separate exam response", status: "running" },
    },
    notes: { letter: "Notes at submission" },
  };
  const examBefore = structuredClone(progress.drafts["exam:letter"]);
  const recorded = [];
  const hooks = [];
  let cursor = 0;
  const context = vm.createContext({
    exports: {},
    window: { setTimeout: (callback) => callback() },
    require: (name) => {
      if (name === "react")
        return {
          ...React,
          useState: (initial) => {
            const slot = cursor++;
            if (!(slot in hooks))
              hooks[slot] = typeof initial === "function" ? initial() : initial;
            return [
              hooks[slot],
              (next) => {
                hooks[slot] =
                  typeof next === "function" ? next(hooks[slot]) : next;
              },
            ];
          },
          useRef: (initial) => {
            const slot = cursor++;
            return (hooks[slot] ||= { current: initial });
          },
          useEffect: () => {},
        };
      if (name === "../lib/progress")
        return {
          getProgress: () => progress,
          saveDraft: (id, value) => {
            progress.drafts[id] = value;
          },
          recordAttempt: (value) => recorded.push(value),
        };
      if (name === "../lib/study.mjs") return study;
      if (name === "../lib/computer-writing-ui.mjs") return writingUi;
      if (name === "../lib/runtime") return {};
      if (name === "../lib/recordings") return {};
      if (name === "./SpeakingRecordings") return { default: () => null };
      if (name === "./PracticeFrame" || name === "../lib/content") return {};
      if (name.endsWith(".css")) return {};
      return require(name);
    },
  });
  vm.runInContext(code, context);
  const render = () => {
    cursor = 0;
    return context.WritingPractice({
      item: {
        id: "letter",
        title: "Letter",
        kind: "writing",
        data: { writingPart: 1 },
      },
    });
  };
  const save = (frame) => frame.props.children[0].props.children[2];
  let frame = render();
  frame.props.actions.props.onClick();
  frame = render();
  const saveButton = save(frame);
  saveButton.props.onClick();
  saveButton.props.onClick();
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].answers.essay, "My first response");
  assert.equal(recorded[0].answers.notes, "Notes at submission");
  assert.equal(progress.drafts.letter.practiceStatus, "completed");
  assert.deepEqual(progress.drafts["exam:letter"], examBefore);

  frame = render();
  assert.equal(frame.props.actions.props.children, "继续编辑");
  frame.props.actions.props.onClick();
  frame = render();
  const editor = frame.props.children[1].props.children[1];
  editor.props.onChange({ target: { value: "A revised response" } });
  frame = render();
  frame.props.actions.props.onClick();
  frame = render();
  save(frame).props.onClick();
  assert.equal(recorded.length, 2);
  assert.equal(recorded[1].answers.essay, "A revised response");
  assert.equal(recorded[0].answers.essay, "My first response");
  assert.deepEqual(progress.drafts["exam:letter"], examBefore);
});
