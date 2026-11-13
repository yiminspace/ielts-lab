import { test, expect } from "@playwright/test";
import { startBrowserFixture, seedIdentity } from "./fixture.mjs";

let fixture: Awaited<ReturnType<typeof startBrowserFixture>>;
test.beforeEach(async () => {
  fixture = await startBrowserFixture();
});
test.afterEach(async ({ page }) => {
  await page.close();
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

for (const width of [1440, 390]) {
  test(`review playback keeps timestamps local and question playback continuous at ${width}px`, async ({
    page,
    context,
  }) => {
    if (fixture.hosted) await seedIdentity(context);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#/item/demo-listening");
    await page.getByRole("button", { name: "交卷检查", exact: true }).click();
    await page.getByRole("button", { name: "确认交卷", exact: true }).click();
    await page.reload();
    const player = page.locator('audio[aria-label="听力录音"]');
    await expect(player).toHaveJSProperty("paused", true);
    const timestamps = page.locator(".exam-line-play");
    await timestamps.nth(0).click();
    await expect(player).toHaveJSProperty("paused", false);
    await player.evaluate((node: HTMLAudioElement) => {
      node.currentTime = 5;
    });
    await expect(player).toHaveJSProperty("paused", true);
    expect(
      await player.evaluate((node: HTMLAudioElement) => node.currentTime),
    ).toBeCloseTo(5.143, 2);

    // An explicit loop remains available; the question entry must clear it.
    const loop = page.getByRole("checkbox", { name: "单句循环" });
    await loop.check();
    await timestamps.nth(0).click();
    await player.evaluate((node: HTMLAudioElement) => {
      node.currentTime = 5.1;
    });
    await expect
      .poll(() => player.evaluate((node: HTMLAudioElement) => node.currentTime))
      .toBeLessThan(1);
    await page
      .getByRole("button", { name: "播放第 1 题录音", exact: true })
      .click();
    await expect(loop).not.toBeChecked();
    await player.evaluate((node: HTMLAudioElement) => {
      node.currentTime = 5;
    });
    await expect
      .poll(() => player.evaluate((node: HTMLAudioElement) => node.currentTime))
      .toBeGreaterThan(5.4);
    await expect(player).toHaveJSProperty("paused", false);
    await page
      .getByRole("button", { name: "暂停第 1 题录音", exact: true })
      .click();
    await expect(player).toHaveJSProperty("paused", true);

    // Switching back from continuous playback restores the sentence boundary.
    await page
      .getByRole("button", { name: "播放第 1 题录音", exact: true })
      .click();
    await timestamps.nth(1).click();
    await player.evaluate((node: HTMLAudioElement) => {
      node.currentTime = 9.1;
    });
    await expect(player).toHaveJSProperty("paused", true);
    expect(
      await player.evaluate((node: HTMLAudioElement) => node.currentTime),
    ).toBeCloseTo(9.26, 2);
    await expect(
      page.getByRole("button", { name: "播放第 1 题录音", exact: true }),
    ).toBeVisible();
  });
}
