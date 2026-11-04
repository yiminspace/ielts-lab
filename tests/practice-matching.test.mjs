import test from "node:test";
import assert from "node:assert/strict";
import { buildGroups } from "../apps/web/src/lib/questions.mjs";
import { diagramMatchingMatrix } from "../apps/web/src/lib/practice-matching.mjs";
function group(
  content = "<div>&nbsp;15 Reception ......<br />16 Studio ......</div>",
) {
  return buildGroups({
    questions: [
      {
        questionJson: {
          questionType: "4",
          questionNum: 2,
          startIndex: 15,
          endIndex: 16,
          optionsImgSrc: "/media/original.svg",
          questionsContent: content,
          matchOptions: ["A", "B", "C"].map((index) => ({
            index,
            content: "",
          })),
        },
        answerJson: [],
      },
    ],
  })[0];
}
test("diagram labels match numbered rows without using answer keys", () => {
  const result = diagramMatchingMatrix(group());
  assert.deepEqual(result.rows, [
    { rowId: "0:0", html: "Reception" },
    { rowId: "0:1", html: "Studio" },
  ]);
  assert.equal(result.options.length, 3);
  assert.deepEqual(
    diagramMatchingMatrix(
      group(
        "<p><strong>15</strong> Reception ......</p><p>16 Studio ......</p>",
      ),
    ),
    result,
  );
});
test("ambiguous diagrams preserve the source layout and fallback controls", () => {
  for (const content of [
    "<div>16 Reception ......<br>15 Studio ......</div>",
    "<div>15 Reception ......</div>",
    "<div>Heading<br>15 Reception ......<br>16 Studio ......</div>",
    "<table><tr><td>15 Reception ......</td><td>16 Studio ......</td></tr></table>",
    "<div>15 Reception ......<br>16 Studio ......</div><script>alert(1)</script>",
  ])
    assert.equal(diagramMatchingMatrix(group(content)), null);
  const missingImage = group();
  missingImage.optionsImage = "";
  assert.equal(diagramMatchingMatrix(missingImage), null);
  const words = group();
  words.rows[0].options[0].content = "A description";
  assert.equal(diagramMatchingMatrix(words), null);
  const roman = group();
  roman.rows[0].options[0].label = "i";
  assert.equal(diagramMatchingMatrix(roman), null);
});
