import { test, expect } from "@playwright/test";
import { startBrowserFixture, seedIdentity } from "./fixture.mjs";

let fixture: Awaited<ReturnType<typeof startBrowserFixture>>;
test.beforeAll(async () => {
  fixture = await startBrowserFixture();
});
test.afterAll(async () => {
  await fixture?.stop();
});

test("copying a transcript selection includes only the selected original text", async ({
  page,
  context,
}) => {
  if (fixture.hosted) await seedIdentity(context);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/#/item/demo-listening");
  await page.getByRole("button", { name: "精听 · 原文", exact: true }).click();
  await page.getByRole("button", { name: "显示译文", exact: true }).click();
  const sources = page.locator("[data-transcript-source]");
  await expect(sources.first()).toBeVisible();
  const texts = await sources.allTextContents();
  expect(texts.length).toBeGreaterThan(2);

  // Use a real browser selection and native copy command, including partial ends
  // and reverse selections. Intermediate rows contain playback timestamps.
  for (const reverse of [false, true]) {
    await page.evaluate((reverse) => {
      const nodes = document.querySelectorAll("[data-transcript-source]");
      const start = nodes[0].firstChild!;
      const end = nodes[2].firstChild!;
      const selection = window.getSelection()!;
      if (reverse) selection.setBaseAndExtent(end, 12, start, 5);
      else selection.setBaseAndExtent(start, 5, end, 12);
    }, reverse);
    await page.keyboard.press("ControlOrMeta+c");
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe([texts[0].slice(5), texts[1], texts[2].slice(0, 12)].join("\n"));
  }

  // Selecting within one text node must preserve the precise substring.
  await page.evaluate(() => {
    const node = document.querySelector(
      "[data-transcript-source]",
    )!.firstChild!;
    window.getSelection()!.setBaseAndExtent(node, 5, node, 12);
  });
  await page.keyboard.press("ControlOrMeta+c");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(texts[0].slice(5, 12));

  await page.getByRole("button", { name: "交卷检查", exact: true }).click();
  await page.getByRole("button", { name: "确认交卷", exact: true }).click();
  await page
    .getByRole("button", { name: "播放第 2 题录音", exact: true })
    .click();
  await expect(page.locator(".exam-transcript-target")).toHaveText(
    "第 2 题依据",
  );
  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector(".exam-transcript")!);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
  });
  await page.keyboard.press("ControlOrMeta+c");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(texts.join("\n"));
});
