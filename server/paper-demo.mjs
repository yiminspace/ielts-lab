import { demoItems } from "./demo.mjs";

const listening = demoItems.find((item) => item.id === "demo-listening");

// Four distinct parts deliberately repeat one short original recording. This
// fixture tests transitions and restoration, not full IELTS listening coverage.
export const paperDemoItems = Array.from({ length: 4 }, (_, index) => {
  const data = structuredClone(listening.data);
  const start = index * 4 + 1;
  data.part = index + 1;
  data.questions = data.questions.map((question) => ({
    ...question,
    questionId: `original-flow-listening-${index + 1}`,
    questionJson: {
      ...question.questionJson,
      startIndex: start,
      endIndex: start + 3,
      questionsContent: `<h3>Original flow sample · Part ${index + 1}</h3><p>This short recording is intentionally repeated in all four sample parts.</p><p>${start}. The club meets on ...... .</p><p>${start + 1}. Monthly membership costs £ ...... .</p><p>${start + 2}. The first meeting is in the ...... .</p><p>${start + 3}. Register by ...... .</p>`,
    },
  }));
  return {
    ...listening,
    id: `paper-demo-listening-${index + 1}`,
    title: `流程短样例 · Listening Part ${index + 1}`,
    collection: "原创整套流程短样例",
    description: "4题短样例；四个部分重复同一段原创音频，仅用于体验整套流程。",
    source: "original",
    testTrack: "shared",
    data,
  };
});

export const paperDemo = {
  id: "original-general-flow-demo",
  title: "原创 G 类整套流程短样例",
  collection: "原创整套流程短样例",
  testTrack: "general",
  source: "original",
  shortDemo: true,
  listeningIds: paperDemoItems.map((item) => item.id),
  readingIds: [1, 2, 3].map((part) => `general-reading-section-${part}`),
  writingIds: [
    "general-writing-task-1-formal",
    "general-writing-task-2-community",
  ],
  issues: [
    "仅为流程短样例：听力16题、阅读18题、写作2题，不是完整40题试卷。",
    "四个听力部分重复同一段约17秒的原创音频，用于验证换段与恢复流程。",
  ],
};
