import { test, expect } from "@playwright/test";
import { startBrowserFixture, seedIdentity } from "./fixture.mjs";

// Each case owns its progress store, including submitted reviews and delayed draft writes.
let fixture: Awaited<ReturnType<typeof startBrowserFixture>>;
test.beforeEach(async () => {
  fixture = await startBrowserFixture();
});
test.afterEach(async ({ page }) => {
  await page.close();
  await fixture?.stop();
});

// Original questions with the same structural shape as a diagram-matching task.
const options = Array.from({ length: 9 }, (_, index) => ({
  index: String.fromCharCode(65 + index),
  content: "",
}));
const labels = [
  "Reception",
  "Reading room",
  "Workshop",
  "Garden",
  "Cafe",
  "Studio",
];
const questions = [
  {
    questionJson: {
      questionType: "2",
      startIndex: 11,
      endIndex: 12,
      questionNum: 2,
      descriptions:
        "<div>Questions 11 and 12<br>Choose TWO letters, A–E.</div>",
      questions: [
        {
          number: 2,
          content: "Which TWO facilities are available?",
          options: [
            "A quiet room",
            "A workshop",
            "A pool",
            "A gym",
            "A cinema",
          ].map((content) => ({ content })),
        },
      ],
    },
    answerJson: [{ correctValue: ["0", "1"] }],
  },
  {
    questionJson: {
      questionType: "4",
      startIndex: 15,
      endIndex: 20,
      questionNum: 6,
      descriptions:
        "<div>Questions 15–20<br>Label the map below.<br>Write the correct letter, A–I.</div>",
      matchOptions: options,
      optionsImgSrc: "/media/original-layout-map.svg",
      questionsContent: `<div>${labels.map((label, index) => `&nbsp;${index + 15} ${label} ......`).join("<br>")}</div>`,
    },
    answerJson: labels.map(() => ({
      correctValue: "1",
      explain: "Original explanation.",
    })),
  },
];

test.beforeEach(async ({ page, context }) => {
  if (fixture.hosted) await seedIdentity(context);
  await page.route("**/api/items/demo-listening", async (route) => {
    const response = await route.fetch();
    const item = await response.json();
    item.data.questions = questions;
    await route.fulfill({ json: item });
  });
  await page.route("**/media/original-layout-map.svg", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 400"><rect width="500" height="400" fill="white"/><text x="160" y="30" font-size="22">Learning centre</text><path d="M30 60H470V370H30Z M180 60V370 M330 60V370 M30 160H470 M30 270H470" fill="none" stroke="black" stroke-width="2"/><g font-size="26">' +
        options
          .map(
            (o, i) =>
              `<text x="${90 + (i % 3) * 150}" y="${125 + Math.floor(i / 3) * 105}">${o.index}</text>`,
          )
          .join("") +
        "</g></svg>",
    }),
  );
});

test("compact listening keeps the diagram next to a clickable matrix and preserves answers on refresh and review", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/item/demo-listening");
  const panel = page.getByRole("region", { name: "地图匹配选项，可横向滚动" });
  await expect(panel).toBeVisible();
  const workspace = await page.locator(".pf-workarea").boundingBox();
  expect(workspace!.height).toBeGreaterThan(700);
  expect(workspace!.y).toBeLessThan(140);
  const choices = page.locator(".exam-choice-question");
  await choices.getByRole("checkbox").nth(0).check();
  await choices.getByRole("checkbox").nth(1).check();
  await expect(choices.getByRole("checkbox").nth(2)).toBeDisabled();
  await choices.getByRole("checkbox").nth(0).uncheck();
  await choices.getByRole("checkbox").nth(2).check();
  await expect(choices.getByRole("checkbox").nth(2)).toBeChecked();
  const map = await page.locator(".exam-map").boundingBox();
  const matrix = await panel.boundingBox();
  expect(map!.x + map!.width).toBeLessThan(matrix!.x);
  const first = page.getByRole("radio", { name: "第 15 题，B", exact: true });
  await first.check();
  await page.getByRole("radio", { name: "第 16 题，B", exact: true }).check();
  await expect(first).toBeChecked();
  await page.getByRole("radio", { name: "第 15 题，C", exact: true }).check();
  await expect(first).not.toBeChecked();
  await page
    .getByRole("radio", { name: "第 15 题，C", exact: true })
    .press("ArrowRight");
  await expect(
    page.getByRole("radio", { name: "第 15 题，D", exact: true }),
  ).toBeChecked();
  await page
    .getByRole("button", { name: "第 20 题，未作答", exact: true })
    .click();
  await expect(
    page.getByRole("radio", { name: "第 20 题，A", exact: true }),
  ).toBeFocused();
  await expect
    .poll(async () => {
      const progress = await page.evaluate(async () =>
        (await fetch("/api/progress")).json(),
      );
      return JSON.stringify(progress.drafts);
    })
    .toContain('"1:0":"3"');
  await page.reload();
  await expect(
    page.getByRole("radio", { name: "第 15 题，D", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("radio", { name: "第 16 题，B", exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: "交卷检查", exact: true }).click();
  await page.getByRole("button", { name: "确认交卷", exact: true }).click();
  await expect(
    page.getByText("Review · 作答复盘", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "第 15 题，D", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".exam-matrix-feedback")).toHaveCount(6);
  await expect(page.locator(".exam-matrix-feedback").first()).toContainText(
    "正确答案",
  );
});

test("mobile keeps the shell compact and confines the wide matrix to its own scroller", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/item/demo-listening");
  await expect(page.locator(".exam-map")).toBeVisible();
  const workarea = await page.locator(".pf-workarea").boundingBox();
  expect(workarea!.y).toBeLessThan(155);
  expect(workarea!.height).toBeGreaterThan(620);
  const sizes = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.width);
  const frame = page.locator(".exam-matrix-frame");
  expect(await frame.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
    true,
  );
  await page.getByRole("radio", { name: "第 20 题，I", exact: true }).check();
  await expect(
    page.getByRole("radio", { name: "第 20 题，I", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("button", { name: "交卷检查", exact: true }),
  ).toBeVisible();
});

test("listening review underlines evidence across lines, jumps to notes and retries", async ({
  page,
}) => {
  let calls = 0;
  await page.route(
    "**/api/items/demo-listening/listening-review/*",
    async (route) => {
      calls++;
      expect(route.request().method()).toBe("POST");
      expect(route.request().postData()).toBeNull();
      if (calls === 1) return route.fulfill({ status: 503, json: {} });
      return route.fulfill({
        json: {
          evidence: [
            {
              line: 0,
              quotes: ["conversation club"],
              answer: "A",
              kind: "correct",
              explanation: "这里说明有会话俱乐部。",
            },
            {
              line: 2,
              quotes: ["library", "garden"],
              answer: "B",
              kind: "correct",
              explanation: "这里说明活动地点。",
            },
            {
              line: 3,
              quotes: ["no need to telephone"],
              answer: "C",
              kind: "distractor",
              explanation: "这里排除了电话报名。",
            },
            {
              line: 1,
              quotes: ["invented quotation"],
              answer: "D",
              kind: "correct",
              explanation: "这条不应显示。",
            },
          ],
          unmentioned: ["录音没有提到游泳池。"],
        },
      });
    },
  );
  await page.goto("/#/item/demo-listening");
  await page.getByRole("button", { name: "交卷检查", exact: true }).click();
  await page.getByRole("button", { name: "确认交卷", exact: true }).click();
  expect(calls).toBe(0);
  await page.getByRole("button", { name: "查看第 11–12 题解析" }).click();
  const panel = page.getByRole("region", { name: "Listening transcript" });
  await expect(panel.getByText("解析暂不可用")).toBeVisible();
  await panel.getByRole("button", { name: "重试" }).click();
  await expect(panel.locator("u")).toHaveText([
    "conversation club",
    "library",
    "garden",
    "no need to telephone",
  ]);
  await expect(panel.locator(".exam-evidence-note")).toHaveCount(3);
  await page.getByRole("button", { name: /B · 依据/ }).click();
  await expect(panel.locator(".exam-evidence-note.focused")).toContainText(
    "这里说明活动地点。",
  );
  await page.getByRole("button", { name: "收起第 11–12 题解析" }).click();
  await expect(panel.locator("u")).toHaveCount(0);
  await expect(panel.locator(".exam-evidence-note")).toHaveCount(0);
  await page.getByRole("button", { name: "查看第 15 题解析" }).click();
  await expect(page.getByText("Original explanation.").first()).toBeVisible();
  await expect(panel.getByText(/第 15 题 · AI 解析/)).toHaveCount(0);
  expect(calls).toBe(2);
});
