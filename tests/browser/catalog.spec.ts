import { test, expect } from "@playwright/test";
import { startBrowserFixture, seedIdentity } from "./fixture.mjs";

let fixture: Awaited<ReturnType<typeof startBrowserFixture>>;
test.beforeAll(async () => {
  fixture = await startBrowserFixture();
});
test.afterAll(async () => {
  await fixture?.stop();
});

test("material rows retain practice count and latest result across refresh and mobile layout", async ({
  page,
  context,
}) => {
  if (fixture.hosted) await seedIdentity(context);
  await page.goto("/");
  await expect(page.getByText("自己的节奏，扎实地练习。")).toBeVisible();
  await page.evaluate(async (hosted) => {
    const progress = await (await fetch("/api/progress")).json();
    // Original synthetic submissions, deliberately saved out of time order.
    for (const [day, score] of [
      [27, 4],
      [29, 0],
      [28, 3],
    ]) {
      const attempt = {
        id: crypto.randomUUID(),
        itemId: "demo-listening",
        title: "Original catalog fixture",
        kind: "listening",
        createdAt: `2026-10-${day}T01:00:00Z`,
        score,
        total: 4,
      };
      progress.attempts.push(attempt);
      const response = await fetch(hosted ? "/api/attempts" : "/api/progress", {
        method: hosted ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(hosted ? attempt : progress),
      });
      if (!response.ok) throw new Error("Could not seed catalog submissions");
    }
  }, fixture.hosted);
  await page.goto("/#/library/listening");
  await page.reload();
  const row = page.locator(".material-row").filter({ hasText: "已练习 3 次" });
  await expect(row).toHaveCount(1);
  await expect(
    row.getByText("最近一次：答对 0/4 · 正确率 0%", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("练习状态", { exact: true }).selectOption("done");
  await expect(row).toBeVisible();
  await page.getByLabel("练习状态", { exact: true }).selectOption("new");
  await expect(row).toHaveCount(0);
  await page.getByLabel("练习状态", { exact: true }).selectOption("all");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    row.getByText("最近一次：答对 0/4 · 正确率 0%", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
