import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// These original, already-parsed trees exercise feedback placement independently
// of the browser HTML parser and DOMPurify. Browser checks cover real archived HTML.
const text = (textContent) => ({ nodeType: 3, textContent });
function element(tag, children, attrs = {}) {
  return {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    childNodes: children.map((child) =>
      typeof child === "string" ? text(child) : child,
    ),
    getAttribute: (name) => attrs[name] ?? null,
  };
}

const source = await readFile(
  new URL("../apps/web/src/components/ExamWorkspace.tsx", import.meta.url),
  "utf8",
);
const code = ts.transpileModule(`${source}\nexport { HtmlContent };`, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;
const require = createRequire(import.meta.url);

function renderTree(nodes, feedback = (index) => index, expandedReviews = []) {
  const calls = [];
  const context = vm.createContext({
    exports: {},
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    document: {
      createElement: () => ({
        childNodes: [],
        set innerHTML(value) {
          assert.equal(value, "original fixture");
          this.childNodes = nodes;
        },
      }),
    },
    require: (name) => {
      if (name === "dompurify")
        return { default: { sanitize: (html) => html } };
      if (name === "../lib/content") return { mediaUrl: () => "" };
      if (name === "../lib/progress" || name === "./PracticeFrame") return {};
      if (name.startsWith("../lib/") || name.endsWith(".css")) return {};
      return require(name);
    },
  });
  vm.runInContext(code, context);
  const html = renderToStaticMarkup(
    React.createElement(context.exports.HtmlContent, {
      html: "original fixture",
      item: { id: "original" },
      gap: (index) =>
        React.createElement("span", { "data-gap": index }, `blank ${index}`),
      gapFeedback: (index) => {
        calls.push(index);
        const id = feedback(index);
        return id == null
          ? null
          : {
              summary: React.createElement(
                "section",
                { "data-review": id },
                "feedback",
              ),
              details: expandedReviews.includes(id)
                ? React.createElement(
                    "aside",
                    { "data-details": id },
                    "explanation",
                  )
                : null,
            };
      },
    }),
  );
  return { html, calls };
}

test("an emphasized gap keeps the complete paragraph beside its review summary", () => {
  const { html, calls } = renderTree([
    element("p", ["Meeting day: ", element("strong", ["......"]), "."]),
    element("p", ["Next question."]),
  ]);
  assert.match(
    html,
    /<div class="exam-review-row "><div class="exam-review-prompt"><p>Meeting day: <strong><span data-gap="0">blank 0<\/span><\/strong>\.<\/p><\/div><div class="exam-review-meta"><section data-review="0">feedback<\/section><\/div><\/div><p>Next question\.<\/p>/,
  );
  assert.doesNotMatch(html, /<p>[^<]*<div|<strong><div/);
  assert.deepEqual(calls, [0]);
});

test("direct and paragraph list gaps retain feedback inside their own list items", () => {
  const { html, calls } = renderTree([
    element("ul", [
      element("li", ["Start at ......"]),
      element("li", [element("p", ["Finish at ......"])]),
    ]),
  ]);
  assert.match(
    html,
    /<li><div class="exam-review-row "><div class="exam-review-prompt">Start at .*data-review="0">feedback<\/section><\/div><\/div><\/li>/,
  );
  assert.match(
    html,
    /<li><div class="exam-review-row "><div class="exam-review-prompt"><p>Finish at .*data-review="1">feedback<\/section><\/div><\/div><\/li>/,
  );
  assert.doesNotMatch(html, /<ul><div|<\/li><div class="exam-review-row/);
  assert.deepEqual(calls, [0, 1]);
});

test("table feedback stays in its cell, including nested paragraphs and merged cells", () => {
  const { html, calls } = renderTree([
    element("table", [
      element("tbody", [
        element("tr", [
          element("th", ["Date ......"], { rowspan: "2" }),
          element("td", [element("p", ["Location ......"])], { colspan: "2" }),
        ]),
      ]),
    ]),
  ]);
  assert.match(
    html,
    /<th rowSpan="2"><div class="exam-review-row ">.*data-review="0">feedback<\/section><\/div><\/div><\/th>/,
  );
  assert.match(
    html,
    /<td colSpan="2"><div class="exam-review-row "><div class="exam-review-prompt"><p>.*<\/p><\/div><div class="exam-review-meta"><section data-review="1">feedback<\/section><\/div><\/div><\/td>/,
  );
  assert.doesNotMatch(html, /<tr><div|<tbody><div|<table><div/);
  assert.deepEqual(calls, [0, 1]);
});

test("a two-slot question spanning paragraphs attaches one review to its final slot", () => {
  const { html, calls } = renderTree(
    [element("p", ["First part ......"]), element("p", ["Second part ......"])],
    (index) => (index === 1 ? "shared-answer" : null),
  );
  assert.match(
    html,
    /blank 0<\/span><\/p><div class="exam-review-row "><div class="exam-review-prompt"><p>Second part/,
  );
  assert.match(
    html,
    /blank 1<\/span><\/p><\/div><div class="exam-review-meta"><section data-review="shared-answer"/,
  );
  assert.equal((html.match(/data-review=/g) || []).length, 1);
  assert.deepEqual(calls, [0, 1]);
});

test("multiple questions in one paragraph and nested containers are neither lost nor duplicated", () => {
  const { html, calls } = renderTree([
    element("div", [
      element("blockquote", [element("p", ["Choose ...... and ......"])]),
      element("p", ["Then ......"]),
    ]),
  ]);
  assert.match(
    html,
    /<div class="exam-review-row exam-review-multiple"><div class="exam-review-prompt"><p>Choose .*blank 1<\/span><\/p><\/div><div class="exam-review-meta"><section data-review="0">feedback<\/section><section data-review="1">feedback<\/section><\/div><\/div><\/blockquote>/,
  );
  for (let index = 0; index < 3; index++)
    assert.equal(
      (html.match(new RegExp(`data-review="${index}"`, "g")) || []).length,
      1,
    );
  assert.deepEqual(calls, [0, 1, 2]);
});

test("a gap without a surrounding block still receives feedback in the outer question container", () => {
  const { html, calls } = renderTree([text("Arrive at ......")]);
  assert.match(
    html,
    /<div class="exam-review-row "><div class="exam-review-prompt">Arrive at .*blank 0<\/span><\/div><div class="exam-review-meta"><section data-review="0">feedback<\/section><\/div><\/div><\/div>$/,
  );
  assert.deepEqual(calls, [0]);
});

test("expanded explanations follow both prompt and summary inside their own question row", () => {
  const { html, calls } = renderTree(
    [element("p", ["Question ......"]), element("p", ["Next ......"])],
    (index) => index,
    [0],
  );
  assert.match(
    html,
    /<div class="exam-review-meta"><section data-review="0">feedback<\/section><\/div><div class="exam-review-details"><aside data-details="0">explanation<\/aside><\/div><\/div><div class="exam-review-row ">/,
  );
  assert.doesNotMatch(html, /data-details="1"/);
  assert.equal((html.match(/class="exam-review-details"/g) || []).length, 1);
  assert.deepEqual(calls, [0, 1]);
});

test("questions without review feedback retain the original paragraph and list structure", () => {
  const { html } = renderTree(
    [element("p", ["First ......"]), element("ul", [element("li", ["Then ......"])])],
    () => null,
  );
  assert.match(
    html,
    /<p>First <span data-gap="0">blank 0<\/span><\/p><ul><li>Then <span data-gap="1">blank 1<\/span><\/li><\/ul>/,
  );
  assert.doesNotMatch(html, /exam-review-row|exam-review-meta|exam-review-details/);
});
