import { test, expect } from "@playwright/test";
import { startBrowserFixture, seedIdentity } from "./fixture.mjs";

let fixture: Awaited<ReturnType<typeof startBrowserFixture>>;
test.beforeEach(async ({ page, context }) => {
  fixture = await startBrowserFixture();
  if (fixture.hosted) await seedIdentity(context);
  await page.route("**/api/items/demo-listening", async (route) => {
    const response = await route.fetch();
    const item = await response.json();
    item.data.questions = [
      {
        questionJson: {
          questionType: "4",
          startIndex: 15,
          endIndex: 20,
          questionNum: 6,
          descriptions:
            "<p>Questions 15–20</p><p>Which topic will each speaker discuss? Choose SIX answers, A–G.</p>",
          optionsTitle: "<p>Topics</p>",
          matchOptions: [
            "Finding a first job",
            "Planning a community project",
            "Learning from a business setback",
            "Working across different countries",
            "Managing a small budget",
            "Adapting to new markets",
            "Supporting a local charity",
          ].map((content, i) => ({
            index: String.fromCharCode(65 + i),
            content: `<strong>${content}</strong>`,
          })),
          questionsContent:
            "<p>Speakers</p>" +
            ["Alex", "Blair", "Casey", "Drew", "Eden", "Frankie"]
              .map((name, i) => `<p>${15 + i} ${name} ......</p>`)
              .join(""),
        },
        answerJson: Array.from({ length: 6 }, () => ({
          correctValue: "1",
          explain: "Original explanation.",
        })),
      },
    ];
    await route.fulfill({ json: item });
  });
});
test.afterEach(async ({ page }) => {
  await page.close();
  await fixture.stop();
});

for (const width of [1440, 390]) {
  test(`matching dropdown shows descriptions and keeps a compact answer at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#/item/demo-listening");
    const first = page.getByRole("combobox", {
      name: "第 15 题答案",
      exact: true,
    });
    await expect(first).toBeVisible();
    await expect(first.locator("option").nth(2)).toHaveText(
      "B — Planning a community project",
    );
    await first.selectOption("1");
    await expect(
      first.locator("..").locator(".matching-select-value"),
    ).toHaveText("B");
    await expect(first).toHaveAttribute(
      "title",
      "B — Planning a community project",
    );
    await first.selectOption("");
    await expect(first).toHaveValue("");
    await first.focus();
    await expect(first).toBeFocused();
    await first.press("Tab");
    await expect(
      page.getByRole("combobox", { name: "第 16 题答案", exact: true }),
    ).toBeFocused();
    await first.selectOption("1");
    await page
      .getByRole("combobox", { name: "第 16 题答案", exact: true })
      .selectOption("1");
    await expect
      .poll(async () =>
        page.evaluate(async () =>
          JSON.stringify((await (await fetch("/api/progress")).json()).drafts),
        ),
      )
      .toContain('"0:1":"1"');
    await page.reload();
    await expect(first).toHaveValue("1");
    await expect(
      page.getByRole("combobox", { name: "第 16 题答案", exact: true }),
    ).toHaveValue("1");
    expect((await first.boundingBox())!.width).toBeLessThanOrEqual(100);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await first.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath("matching.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "交卷检查", exact: true }).click();
    await page.getByRole("button", { name: "确认交卷", exact: true }).click();
    await expect(first).toBeDisabled();
    await expect(
      first.locator("..").locator(".matching-select-value"),
    ).toHaveText("B");
  });
}
