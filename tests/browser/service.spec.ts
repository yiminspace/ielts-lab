import { test, expect, type BrowserContext } from "@playwright/test";
import {
  startBrowserFixture,
  seedIdentity,
  fakeMicrophone,
  owner,
  other,
} from "./fixture.mjs";

let fixture: Awaited<ReturnType<typeof startBrowserFixture>>;
test.beforeAll(async () => {
  fixture = await startBrowserFixture();
});
test.afterAll(async () => {
  await fixture?.stop();
});
async function ownerContext(context: BrowserContext) {
  if (fixture.hosted) await seedIdentity(context, owner);
}

test("IELTS theme keeps the study layout and scopes exam accessibility settings", async ({
  page,
  context,
}) => {
  await ownerContext(context);
  await page.goto("/");
  await expect(page.getByText("自己的节奏，扎实地练习。")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "ielts");
  const style = await page.locator("body").evaluate((element) => ({
    color: getComputedStyle(element).color,
    font: getComputedStyle(element).fontFamily,
  }));
  expect(style.font).toContain("Arial");
  await page.getByRole("button", { name: "切换为暗色模式" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
  await page.goto("/#/item/demo-reading");
  await expect(page.locator(".practice-frame")).toHaveAttribute(
    "data-theme",
    "ielts",
  );
  await expect(page.locator(".practice-frame")).toHaveAttribute(
    "data-mode",
    "light",
  );
  expect(
    await page
      .locator(".practice-frame")
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  ).toBe("rgb(255, 255, 255)");
});

test("anonymous and other accounts never load materials; owner sessions are checked by the API", async ({
  browser,
}) => {
  test.skip(
    !fixture.hosted,
    "Set IELTS_TEST_ADMIN_DATABASE_URL to exercise real PostgreSQL and owner-only API.",
  );
  const anonymous = await browser.newContext();
  const page = await anonymous.newPage();
  let materialRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/library") materialRequests++;
  });
  await page.goto(fixture.origin);
  await expect(page.getByText("登录 IELTS Lab")).toBeVisible();
  expect(materialRequests).toBe(0);
  expect(
    (await anonymous.request.get(`${fixture.origin}/api/library`)).status(),
  ).toBe(401);
  await anonymous.close();
  const rejected = await browser.newContext();
  await seedIdentity(rejected, other);
  const denied = await rejected.newPage();
  denied.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/library") materialRequests++;
  });
  await denied.goto(fixture.origin);
  await expect(denied.getByText("此账号没有访问权限")).toBeVisible();
  expect(materialRequests).toBe(0);
  expect(
    (await rejected.request.get(`${fixture.origin}/api/recordings`)).status(),
  ).toBe(401);
  await rejected.close();
});

test("expired cookies recover without remounting or losing the active writing draft", async ({
  page,
  context,
}) => {
  test.skip(!fixture.hosted, "Requires real hosted API/PostgreSQL fixture.");
  await ownerContext(context);
  await page.goto("/#/item/demo-writing");
  const editor = page.locator("#writing-answer");
  await expect(editor).toBeVisible();
  await editor.fill("Original browser verification draft.");
  await context.clearCookies();
  const result = await page.evaluate(
    async () => (await fetch("/api/progress")).status,
  );
  expect(result).toBe(200);
  await expect(editor).toHaveValue("Original browser verification draft.");
  await page.goto("/");
  await page.getByRole("button", { name: "用户菜单", exact: true }).click();
  await page.getByRole("menuitem", { name: "退出登录" }).click();
  await expect(page.getByText("登录 IELTS Lab")).toBeVisible();
  expect(
    (await context.request.get(`${fixture.origin}/api/progress`)).status(),
  ).toBe(401);
  await expect(page.getByText("自己的节奏，扎实地练习。")).toHaveCount(0);
});

for (const kind of ["listening", "reading"] as const)
  test(`saved ${kind} reviews remain readable after a session renewal without changing progress`, async ({
    page,
    context,
  }) => {
    test.skip(!fixture.hosted, "Requires real hosted API/PostgreSQL fixture.");
    await ownerContext(context);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await expect(page.getByText("自己的节奏，扎实地练习。")).toBeVisible();
    const attemptId = await page.evaluate(async (kind) => {
      const id = crypto.randomUUID();
      const response = await fetch("/api/attempts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          itemId: `demo-${kind}`,
          title: `Original ${kind} review fixture`,
          kind,
          createdAt: new Date().toISOString(),
          answers: {},
          durationSeconds: 7,
          score: 0,
          total: 4,
        }),
      });
      if (!response.ok)
        throw new Error("Could not create the original review fixture");
      return id;
    }, kind);
    await page.reload();
    await page.getByRole("link", { name: "练习记录", exact: true }).click();
    const row = page
      .locator(".history-row")
      .filter({ hasText: `Original ${kind} review fixture` });
    await expect(row).toBeVisible();
    const before = await page.evaluate(async () =>
      (await fetch("/api/progress")).json(),
    );
    // An API restart also invalidates these opaque cookies. Renew using the
    // synthetic AuthKit identity while keeping the existing browser state.
    await context.clearCookies();
    await row.getByRole("button", { name: "查看复盘", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`review=${attemptId}$`));
    await expect(
      page.getByText("Review · 作答复盘", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "重新作答", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "交卷检查", exact: true }),
    ).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByText("Review · 作答复盘", { exact: true }),
    ).toBeVisible();
    if (kind === "listening") {
      const audio = page.locator('audio[aria-label="听力录音"]');
      const source = await audio.getAttribute("src");
      expect(source).toBeTruthy();
      const response = await context.request.get(
        new URL(source!, fixture.origin).href,
        {
          headers: { Range: "bytes=0-7" },
        },
      );
      expect(response.status()).toBe(206);
      expect(response.headers()["content-range"]).toMatch(/^bytes 0-7\//);
      await audio.evaluate((element: HTMLAudioElement) => element.play());
      await expect
        .poll(() =>
          audio.evaluate((element: HTMLAudioElement) => element.currentTime),
        )
        .toBeGreaterThan(0);
      await audio.evaluate((element: HTMLAudioElement) => element.pause());
    }
    const after = await page.evaluate(async () =>
      (await fetch("/api/progress")).json(),
    );
    expect(after).toEqual(before);
    expect(errors).toEqual([]);
  });

for (const entry of ["submitted draft", "history review"])
  test(`retrying listening from ${entry} starts audio from zero and preserves the previous attempt`, async ({
    page,
    context,
  }) => {
    await ownerContext(context);
    await page.goto("/#/item/demo-listening");
    await expect(
      page.getByRole("button", { name: "交卷检查", exact: true }),
    ).toBeVisible();
    const previousIds = await page.evaluate(async () =>
      (await (await fetch("/api/progress")).json()).attempts.map(
        (attempt: { id: string }) => attempt.id,
      ),
    );
    await page
      .locator(
        ".exam-columns input:not([type]), .exam-columns input[type=text]",
      )
      .first()
      .fill("original retry answer");
    await expect(page.locator(".exam-timer strong")).not.toHaveText("00:00");
    await page.getByRole("button", { name: "交卷检查", exact: true }).click();
    await page.getByRole("button", { name: "确认交卷", exact: true }).click();
    await expect
      .poll(async () => {
        const progress = await page.evaluate(async () =>
          (await fetch("/api/progress")).json(),
        );
        return progress.attempts.some(
          (attempt: { id: string }) => !previousIds.includes(attempt.id),
        );
      })
      .toBe(true);
    const before = await page.evaluate(async () =>
      (await fetch("/api/progress")).json(),
    );
    const attempt = before.attempts.find(
      (value: { id: string }) => !previousIds.includes(value.id),
    );
    if (entry === "history review")
      await page.goto(`/#/item/demo-listening?review=${attempt.id}`);
    else await page.reload();
    await expect(
      page.getByRole("button", { name: "重新作答", exact: true }),
    ).toBeVisible();
    const audio = page.locator('audio[aria-label="听力录音"]');
    await expect
      .poll(() =>
        audio.evaluate((element: HTMLAudioElement) => element.readyState),
      )
      .toBeGreaterThanOrEqual(2);
    const oldPosition = await audio.evaluate(
      (element: HTMLAudioElement, atEnd) => {
        element.pause();
        element.currentTime = atEnd
          ? element.duration
          : Math.min(8, element.duration / 2);
        return element.currentTime;
      },
      entry === "history review",
    );
    await page.getByRole("button", { name: "重新作答", exact: true }).click();
    await page.getByRole("button", { name: "继续查看", exact: true }).click();
    expect(
      await audio.evaluate((element: HTMLAudioElement) => element.paused),
    ).toBe(true);
    expect(
      await audio.evaluate((element: HTMLAudioElement) => element.currentTime),
    ).toBeCloseTo(oldPosition, 1);
    await page.getByRole("button", { name: "重新作答", exact: true }).click();
    // Only the actual confirmation click may start playback. Do not call play()
    // from the test: that would hide the missing retry behavior.
    await page.getByRole("button", { name: "开始练习", exact: true }).click();
    await expect(page.locator(".exam-timer strong")).toHaveText("00:00");
    await expect
      .poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused))
      .toBe(false);
    await expect
      .poll(() =>
        audio.evaluate((element: HTMLAudioElement) => element.currentTime),
      )
      .toBeGreaterThan(0);
    expect(
      await audio.evaluate((element: HTMLAudioElement) => element.currentTime),
    ).toBeLessThan(oldPosition);
    expect(
      await audio.evaluate((element: HTMLAudioElement) => element.ended),
    ).toBe(false);
    await expect(
      page
        .locator(
          ".exam-columns input:not([type]), .exam-columns input[type=text]",
        )
        .first(),
    ).toHaveValue("");
    await expect(
      page.getByRole("button", { name: "交卷检查", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".exam-timer strong")).not.toHaveText("00:00");
    const after = await page.evaluate(async () =>
      (await fetch("/api/progress")).json(),
    );
    expect(after.attempts).toEqual(before.attempts);
  });

test("failed uploads survive reload; another device can play, download and delete the saved recording", async ({
  browser,
}) => {
  const first = await browser.newContext({ acceptDownloads: true });
  await ownerContext(first);
  await fakeMicrophone(first);
  const page = await first.newPage();
  let failed = false;
  await page.route("**/api/recordings?*", async (route) => {
    if (route.request().method() === "POST" && !failed) {
      failed = true;
      await route.fulfill({
        status: 503,
        json: { error: "Original upload failure for recovery test" },
      });
    } else await route.continue();
  });
  await page.goto(`${fixture.origin}/#/item/demo-speaking`);
  await page.getByRole("button", { name: "开始录音", exact: true }).click();
  await page.getByRole("button", { name: "结束录音", exact: true }).click();
  await expect(
    page.getByText("Original upload failure for recovery test"),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "下载本机录音" })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.reload();
  await expect(
    page.getByRole("button", { name: "重试上传", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "重试上传", exact: true }).click();
  await expect(
    page.locator(".study-recorded").filter({ hasText: "已保存" }),
  ).toHaveCount(1);
  const second = await browser.newContext({ acceptDownloads: true });
  await ownerContext(second);
  const otherDevice = await second.newPage();
  await otherDevice.goto(`${fixture.origin}/#/item/demo-speaking`);
  const saved = otherDevice.locator(".study-recorded");
  await expect(saved).toHaveCount(1);
  const audio = saved.locator("audio");
  await audio.evaluate((element: HTMLAudioElement) => element.play());
  await expect
    .poll(() => audio.evaluate((element: HTMLAudioElement) => element.duration))
    .toBeGreaterThan(0);
  await audio.evaluate((element: HTMLAudioElement) => element.pause());
  const download = otherDevice.waitForEvent("download");
  await otherDevice
    .getByRole("button", { name: "下载录音", exact: true })
    .click();
  expect((await download).suggestedFilename()).toMatch(/\.wav$/);
  otherDevice.once("dialog", (dialog) => dialog.accept());
  await otherDevice.getByRole("button", { name: "删除", exact: true }).click();
  await expect(saved).toHaveCount(0);
  await page.getByRole("button", { name: "刷新列表", exact: true }).click();
  await expect(page.locator(".study-recorded")).toHaveCount(0);
  await second.close();
  await first.close();
});

test("a cross-tab account change hides the previous account and clears its cookie", async ({
  browser,
}) => {
  test.skip(!fixture.hosted, "Requires real hosted API/PostgreSQL fixture.");
  const context = await browser.newContext();
  await ownerContext(context);
  const first = await context.newPage();
  const second = await context.newPage();
  await first.goto(fixture.origin);
  await second.goto(fixture.origin);
  await expect(second.getByText("自己的节奏，扎实地练习。")).toBeVisible();
  await first.evaluate((otherId) => {
    const encode = (value) =>
      btoa(JSON.stringify(value))
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
    localStorage.setItem(
      "authkit_access_token",
      `${encode({ alg: "original-test" })}.${encode({ sub: otherId, exp: Math.floor(Date.now() / 1000) + 3600 })}.original-test-signature`,
    );
  }, other);
  await expect(second.getByText("此账号没有访问权限")).toBeVisible();
  await expect(second.getByText("自己的节奏，扎实地练习。")).toHaveCount(0);
  expect(
    (await context.request.get(`${fixture.origin}/api/library`)).status(),
  ).toBe(401);
  await context.close();
});

test("leaving a speaking workspace stops the microphone and retains the unfinished audio outbox", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await ownerContext(context);
  await fakeMicrophone(context);
  const page = await context.newPage();
  await page.goto(`${fixture.origin}/#/item/demo-speaking`);
  await page.getByRole("button", { name: "开始录音", exact: true }).click();
  await page.getByRole("link", { name: "学习空间", exact: true }).click();
  await expect(page.getByText("自己的节奏，扎实地练习。")).toBeVisible();
  await page.goto(`${fixture.origin}/#/item/demo-speaking`);
  await expect(
    page.getByRole("button", { name: "重试上传", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "重试上传", exact: true }).click();
  await expect(
    page.locator(".study-recorded").filter({ hasText: "已保存" }),
  ).toHaveCount(1);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.locator(".study-recorded")).toHaveCount(0);
  await context.close();
});
