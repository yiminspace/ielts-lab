import test from "node:test";
import assert from "node:assert/strict";
import { dictationDiff } from "../apps/web/src/lib/dictation-diff.mjs";

test("dictation diff identifies omissions, additions and substitutions in order", () => {
  const omitted = dictationDiff(
    "Please bring a notebook.",
    "Please bring notebook.",
  );
  assert.deepEqual(
    omitted.filter((part) => part.type !== "equal"),
    [{ type: "missing", text: "a" }],
  );
  assert.deepEqual(dictationDiff("Bring a book.", "Bring the books."), [
    { type: "equal", text: "Bring" },
    { type: "extra", text: "the" },
    { type: "extra", text: "books." },
    { type: "missing", text: "a" },
    { type: "missing", text: "book." },
  ]);
  assert.ok(
    dictationDiff("HELLO, world!", "Hello world").every(
      (part) => part.type === "equal",
    ),
  );
  assert.equal(dictationDiff("A book.", "").length, 2);
  assert.deepEqual(dictationDiff("", ""), []);
});
