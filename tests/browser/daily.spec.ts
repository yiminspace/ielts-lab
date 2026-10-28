import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  startBrowserFixture,
  seedIdentity,
  fakeMicrophone,
  owner,
} from "./fixture.mjs";

// All language is original. The injected runtime replaces the model only; the
// browser uses the real application, API, persisted jobs, grading and media.
function originalLesson(source: { transcript: string }) {
  const quote = "The new conversation club meets on Monday.";
  return {
    title: "在新的俱乐部认识朋友",
    reading: {
      passage: source.transcript,
      translation:
        "会话俱乐部在周一见面。带上笔记本，每月费用二十英镑。首次活动在图书馆，通过邮件报名。",
      questions: [
        {
          id: "q1",
          kind: "choice",
          prompt: "When does the club meet?",
          options: ["Monday", "Tuesday", "Wednesday"],
          answer: "Monday",
          max_words: 1,
          evidence: quote,
          explanation: "原文明确说每周一见面。",
        },
        {
          id: "q2",
          kind: "true_false",
          prompt: "Visitors should bring a notebook.",
          options: ["True", "False", "Not Given"],
          answer: "True",
          max_words: 1,
          evidence: "Please bring a notebook.",
          explanation: "需要带上笔记本。",
        },
        {
          id: "q3",
          kind: "gap",
          prompt: "The library is next to the ____.",
          options: [],
          answer: "garden",
          max_words: 1,
          evidence:
            "Our first meeting will take place in the library, next to the garden.",
          explanation: "图书馆在花园旁。",
        },
        {
          id: "q4",
          kind: "choice",
          prompt: "How much is a monthly membership?",
          options: ["Ten pounds", "Twenty pounds", "Thirty pounds"],
          answer: "Twenty pounds",
          max_words: 2,
          evidence: "The monthly membership costs twenty pounds.",
          explanation: "月费为二十英镑。",
        },
        {
          id: "q5",
          kind: "gap",
          prompt: "You can register by ____.",
          options: [],
          answer: "email",
          max_words: 1,
          evidence: "You can register by email.",
          explanation: "通过电子邮件报名。",
        },
      ],
    },
    conversation: {
      topic: "Joining a local club",
      opening: "What would you like to do in a new club?",
      opening_zh: "加入一个新俱乐部时，你想做什么？",
      starters: ["I would like to…", "I enjoy…"],
    },
    writing: {
      tasks: [
        {
          level: "basic",
          instruction: "Write a short message asking to join the club.",
          goal: "说明来意并问一个问题。",
          hints: ["I would like to join…", "Could you tell me…?"],
        },
        {
          level: "extension",
          instruction: "Explain what you hope to learn at the club.",
          goal: "补充一个原因。",
          hints: ["I hope to… because…"],
        },
        {
          level: "challenge",
          instruction: "Suggest one way to welcome new members.",
          goal: "比较两个选择并解释理由。",
          hints: ["One option would be…"],
        },
      ],
    },
  };
}

const calls: { workflow: string; input: Record<string, any> }[] = [];
const runtime = {
  configured: true,
  capabilities: async () => ({ model: true, asr: true, tts: true }),
  async start(
    _owner: string,
    request: { workflow: string; input: Record<string, any> },
  ) {
    calls.push({
      workflow: request.workflow,
      input: structuredClone(request.input),
    });
    let output;
    if (request.workflow === "ielts.lesson")
      output = originalLesson(request.input.source);
    else if (request.workflow === "ielts.conversation")
      output = {
        reply_en: request.input.text.includes("Monday")
          ? "Monday sounds like a good time to meet new people."
          : "Sharing a story can help everyone get to know you.",
        follow_up: request.input.text.includes("Monday")
          ? "What would you share with the group?"
          : "Why would you choose that story?",
        feedback_zh: "意思表达清楚，可以再补充一个具体细节。",
        outcome: "expressed",
      };
    else if (request.workflow === "ielts.expression")
      output = {
        english: "I would like to join the club and make new friends.",
        clarification_zh: "",
      };
    else
      output = {
        feedback_zh: "来意很清楚。注意 join 后面直接接 the club。",
        corrections: [
          {
            original: "join to the club",
            corrected: "join the club",
            reason_zh: "join 表示加入团体时直接接宾语。",
          },
        ],
        suggestion_en:
          "I would like to join the club. Could you tell me when it starts?",
        task_complete: false,
        follow_up_zh: request.input.text.includes("为什么")
          ? "join 是及物动词，在这里直接接团体名称。"
          : "可以修改这个表达，再试一次。",
      };
    return { id: crypto.randomUUID(), status: "completed", output };
  },
  get: async () => {
    throw new Error(
      "Completed synthetic runs do not require polling the provider.",
    );
  },
  transcribe: async () => ({ text: "I would meet the club on Monday." }),
  synthesize: async () => ({
    contentType: "audio/wav",
    bytes: await readFile(
      new URL("../../services/api/assets/demo-speaking-0.wav", import.meta.url),
    ),
  }),
};

async function login(
  context: BrowserContext,
  fixture: Awaited<ReturnType<typeof startBrowserFixture>>,
) {
  if (fixture.hosted) await seedIdentity(context, owner);
}
async function submitListening(page: Page) {
  await page.goto("/#/item/demo-listening");
  await expect(
    page.getByRole("button", { name: "交卷检查", exact: true }),
  ).toBeVisible();
  const inputs = page.locator(
    ".exam-columns input:not([type]), .exam-columns input[type=text]",
  );
  await expect(inputs).toHaveCount(4);
  for (const [index, text] of ["Monday", "20", "library", "email"].entries())
    await inputs.nth(index).fill(text);
  await page.getByRole("button", { name: "交卷检查", exact: true }).click();
  await page.getByRole("button", { name: "确认交卷", exact: true }).click();
  await expect(page.getByLabel("听后练习")).toBeVisible();
}

test.describe("Daily real API with an original injected runtime", () => {
  let fixture: Awaited<ReturnType<typeof startBrowserFixture>>;
  test.beforeAll(async () => {
    fixture = await startBrowserFixture({
      runtimeClient: runtime,
      dailyPollInterval: 40,
    });
  });
  test.afterAll(async () => {
    await fixture?.stop();
  });

  test("listening submission creates one lesson; reading, free conversation, writing and voice survive refresh", async ({
    page,
    context,
  }) => {
    test.setTimeout(90000);
    await login(context, fixture);
    await fakeMicrophone(context);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await submitListening(page);
    await expect(page.getByRole("link", { name: "打开听后练习" })).toBeVisible({
      timeout: 15000,
    });
    expect(page.url()).toContain("#/item/demo-listening");
    await page.getByRole("link", { name: "打开听后练习" }).click();
    await expect(
      page.getByRole("heading", { name: "在新的俱乐部认识朋友" }),
    ).toBeVisible();
    await expect(
      page.getByText("口语训练目标 6.5", { exact: true }),
    ).toBeVisible();
    expect(
      calls.filter((call) => call.workflow === "ielts.lesson"),
    ).toHaveLength(1);
    expect(
      calls.find((call) => call.workflow === "ielts.lesson")?.input,
    ).toMatchObject({ source: { part: 1 }, target_band: 6.5 });

    await page.getByRole("tab", { name: "阅读理解" }).click();
    await expect(page.locator(".daily-reading-result")).toHaveCount(0);
    await page.getByRole("radio", { name: "Monday", exact: true }).check();
    await page.getByRole("radio", { name: "True", exact: true }).check();
    await page
      .getByRole("textbox", { name: "第 3 题答案", exact: true })
      .fill("garden");
    await page
      .getByRole("radio", { name: "Twenty pounds", exact: true })
      .check();
    await page
      .getByRole("textbox", { name: "第 5 题答案", exact: true })
      .fill("email");
    await page.getByRole("button", { name: "提交阅读答案" }).click();
    await expect(
      page.getByText("本次阅读答对 5 / 5 题。原文与解析会保留。"),
    ).toBeVisible();
    await expect(page.locator(".daily-reading-result blockquote")).toHaveCount(
      5,
    );

    await page.getByRole("tab", { name: "主题交流" }).click();
    const conversation = page.getByRole("textbox", { name: "接着聊一聊" });
    await conversation.fill("I would join on Monday.");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(
      page
        .locator(".daily-message-assistant")
        .filter({ hasText: "Monday sounds" }),
    ).toBeVisible();
    await conversation.fill("I would share a story about my garden.");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(
      page
        .locator(".daily-message-assistant")
        .filter({ hasText: "Sharing a story" }),
    ).toBeVisible();
    const turns = calls.filter(
      (call) => call.workflow === "ielts.conversation",
    );
    expect(turns).toHaveLength(2);
    expect(turns[1].input.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          text: "I would join on Monday.",
        }),
        expect.objectContaining({
          role: "assistant",
          text: "Monday sounds like a good time to meet new people.",
        }),
      ]),
    );

    await conversation.fill("我想加入俱乐部，认识朋友。");
    await page
      .getByRole("button", { name: "帮我用英语表达", exact: true })
      .click();
    await expect(page.locator(".daily-expression-help")).toContainText(
      "I would like to join the club and make new friends.",
    );
    await conversation.fill("Original unsent conversation draft.");
    await page.reload();
    await expect(conversation).toHaveValue(
      "Original unsent conversation draft.",
    );
    await expect(page.locator(".daily-message-user")).toHaveCount(2);

    await page.getByRole("tab", { name: "写作练习" }).click();
    const writing = page.getByRole("textbox", {
      name: "写下你的表达",
      exact: true,
    });
    await writing.fill("I would like to join to the club. When does it start?");
    await page.getByRole("button", { name: "请老师看看" }).click();
    await expect(page.locator(".daily-writing-feedback")).toContainText(
      "join 表示加入团体时直接接宾语。",
    );
    await page
      .getByRole("textbox", { name: "对这次修改有什么疑问？" })
      .fill("为什么这里不用 to？");
    await page.getByRole("button", { name: "发送问题", exact: true }).click();
    await expect(page.locator(".daily-writing-discussion")).toContainText(
      "join 是及物动词",
    );
    await writing.fill("Original revision that I will finish later.");
    await page.reload();
    await page.getByRole("tab", { name: "写作练习" }).click();
    await expect(writing).toHaveValue(
      "Original revision that I will finish later.",
    );
    await expect(page.locator(".daily-writing-feedback").first()).toContainText(
      "I would like to join to the club.",
    );

    await page.getByRole("tab", { name: "主题交流" }).click();
    await conversation.fill("");
    await page.getByRole("button", { name: "用语音回答", exact: true }).click();
    await page.getByRole("button", { name: /说完并发送/ }).click();
    await expect(page.locator(".daily-message-user")).toHaveCount(3);
    await expect(page.locator(".daily-message-user audio")).toHaveCount(1);
    await expect(
      page.getByText("老师正在回应… 已保存请求，可以稍后继续。"),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "听老师回复", exact: true })
      .last()
      .click();
    await expect(page.getByLabel("老师语音", { exact: true })).toHaveAttribute(
      "src",
      /\/api\/daily\/.*\/recordings\/teacher-/,
    );
    const audioResponse = await page.request.get(
      (await page
        .getByLabel("老师语音", { exact: true })
        .getAttribute("src")) as string,
    );
    expect(audioResponse.status()).toBe(200);
    expect(audioResponse.headers()["content-type"]).toContain("audio/wav");

    // Lose the acknowledgement after the real server accepted the answer. The
    // same request ID must recover the saved reply without duplicating a turn.
    let interrupted = false;
    const requestIds: string[] = [];
    await page.route("**/api/daily/*/conversation", async (route) => {
      requestIds.push(route.request().postDataJSON().requestId);
      if (!interrupted) {
        interrupted = true;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await conversation.fill("I would bring a notebook.");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "重试上次操作" }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByRole("alert")).toContainText("上次操作尚未收到确认");
    await page.getByRole("button", { name: "重试上次操作" }).click();
    await expect(page.locator(".daily-message-user")).toHaveCount(4);
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).toBe(requestIds[1]);
    await page.unroute("**/api/daily/*/conversation");
    await expect(conversation).toBeEnabled();

    // A second writer advances the real lesson version before this tab sends.
    await conversation.fill("I would ask about the next meeting.");
    await page.evaluate(async () => {
      const id = location.hash.slice("#/daily/".length);
      const lesson = await (await fetch(`/api/daily/${id}`)).json();
      const response = await fetch(`/api/daily/${id}/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedVersion: lesson.version,
          requestId: crypto.randomUUID(),
          section: "writing",
          text: "Original second-writer draft",
          level: "basic",
        }),
      });
      if (!response.ok)
        throw new Error("Original concurrent draft could not be saved.");
    });
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("进度已在另一处更新");
    await expect(conversation).toHaveValue(
      "I would ask about the next meeting.",
    );
    await page.getByRole("button", { name: "重试上次操作" }).click();
    await expect(page.locator(".daily-message-user")).toHaveCount(5);
    await expect(conversation).toBeEnabled();

    await page.getByRole("button", { name: "识别不对", exact: true }).click();
    await expect(
      page.locator(".daily-message-user.daily-message-excluded"),
    ).toContainText("这次识别不作为学习判断");
    await expect(
      page.locator(".daily-message-user.daily-message-excluded audio"),
    ).toHaveCount(1);
    await conversation.fill("I would listen to everyone's ideas.");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator(".daily-message-user")).toHaveCount(6);
    await expect(conversation).toBeEnabled();
    const latestConversation = calls
      .filter((call) => call.workflow === "ielts.conversation")
      .at(-1)!;
    expect(
      latestConversation.input.history.some(
        (message: { text: string }) =>
          message.text === "I would meet the club on Monday.",
      ),
    ).toBe(false);
    await page
      .getByRole("button", { name: "结束本次交流", exact: true })
      .click();
    await expect(conversation).toBeDisabled();
    await page.reload();
    await expect(
      page.getByRole("button", { name: "继续这次交流", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "继续这次交流", exact: true })
      .click();
    await expect(conversation).toBeEnabled();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole("textbox", { name: "接着聊一聊" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect
      .poll(
        async () =>
          (await page.locator(".sidebar").boundingBox())!.x +
          (await page.locator(".sidebar").boundingBox())!.width,
      )
      .toBeLessThanOrEqual(0);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({
      path: "/tmp/ielts-daily-mobile.png",
      fullPage: true,
    });
    expect(pageErrors).toEqual([]);
  });
});

test.describe("Daily without configured model services", () => {
  let fixture: Awaited<ReturnType<typeof startBrowserFixture>>;
  test.beforeAll(async () => {
    fixture = await startBrowserFixture();
  });
  test.afterAll(async () => {
    await fixture?.stop();
  });
  test("preserves the listening attempt and explains the blocked generation", async ({
    page,
    context,
  }) => {
    await login(context, fixture);
    await submitListening(page);
    await expect(page.getByLabel("听后练习")).toContainText("AI 服务尚未配置", {
      timeout: 15000,
    });
    await page.getByRole("link", { name: "查看听后练习" }).click();
    await expect(
      page.getByRole("heading", { name: "AI 服务尚未配置" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "重试生成" })).toBeVisible();
    await expect(page.getByRole("tab")).toHaveCount(0);
    const persisted = await page.evaluate(async () =>
      (await fetch("/api/progress")).json(),
    );
    expect(persisted.attempts).toHaveLength(1);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "AI 服务尚未配置" }),
    ).toBeVisible();
  });
});
