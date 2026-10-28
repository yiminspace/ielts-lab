import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { createApp } from "../services/api/index.mjs";
import { createDailyAudio } from "../services/api/daily-audio.mjs";
import { PostgresStore } from "../services/api/postgres.mjs";
import { loadLibrary } from "../services/api/library.mjs";
import {
  createDaily,
  createLocalDailyStore,
  createRuntimeClient,
  seedDailyLesson,
} from "../services/api/daily.mjs";

const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const attempt = (extra = {}) => ({
  id: randomUUID(),
  itemId: "demo-listening",
  kind: "listening",
  title: "Browser title is not trusted",
  answers: { "0:0": "Monday" },
  createdAt: new Date().toISOString(),
  ...extra,
});
const originalContent = (source) => ({
  title: "Original listening practice",
  reading: {
    passage: source.transcript,
    translation: "原创示例译文",
    questions: Array.from({ length: 5 }, (_, i) => ({
      id: `q${i}`,
      kind: i % 2 ? "gap" : "choice",
      prompt: `Original question ${i}`,
      options: i % 2 ? [] : ["Monday", "Tuesday", "Friday"],
      answer: "Monday",
      max_words: 3,
      evidence: source.transcript.split("\n")[0],
      explanation: "根据原文核对答案。",
    })),
  },
  conversation: {
    topic: "Learning clubs",
    opening: "Which club would you join?",
    opening_zh: "你会加入哪个俱乐部？",
    starters: ["I would join..."],
  },
  writing: {
    tasks: ["basic", "extension", "challenge"].map((level) => ({
      level,
      instruction: "Describe a club you would join.",
      goal: "Explain one preference.",
      hints: ["Give a reason."],
    })),
  },
});
function fakeRuntime(options = {}) {
  const calls = [];
  return {
    configured: true,
    calls,
    capabilities: async () => ({ model: true, asr: true, tts: true }),
    start: async (userId, body) => {
      calls.push({ userId, ...structuredClone(body) });
      if (options.fail)
        throw Object.assign(new Error("Original temporary failure"), {
          status: 502,
        });
      if (options.queued) return { id: "original-run", status: "running" };
      const outputs = {
        "ielts.lesson": () => originalContent(body.input.source),
        "ielts.conversation": () => ({
          reply_en: "That sounds interesting.",
          follow_up: "Why would you choose it?",
          feedback_zh: "理由已经表达清楚，可以再加一个细节。",
          outcome: "expressed",
        }),
        "ielts.expression": () => ({
          english: "I would like to join the club.",
          clarification_zh: "",
        }),
        "ielts.writing": () => ({
          feedback_zh: "你已完成基本表达。",
          corrections: [],
          suggestion_en: "Add one specific example.",
          task_complete: true,
          follow_up_zh: "你能补充一个例子吗？",
        }),
      };
      const output = outputs[body.workflow]();
      options.output?.(output);
      return { id: `run-${calls.length}`, status: "completed", output };
    },
    get: async () => ({
      id: "original-run",
      status: "completed",
      output: originalContent(calls[0].input.source),
    }),
    transcribe: async (_owner, bytes, contentType) => {
      calls.push({ speech: "transcribe", bytes: bytes.length, contentType });
      return { text: "I would join the conversation club." };
    },
    synthesize: async (_owner, text) => {
      calls.push({ speech: "synthesize", text });
      return {
        bytes: Buffer.from("original-generated-test-audio"),
        contentType: "audio/mpeg",
      };
    },
  };
}
async function fixture(t, runtime = fakeRuntime()) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ielts-daily-original-test-"),
  );
  const library = await loadLibrary({ forceDemo: true });
  const service = createDaily({
    root,
    library,
    ownerId: owner,
    runtimeClient: runtime,
    pollInterval: 1000000,
  });
  t.after(async () => {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve) => setImmediate(resolve));
  return { root, library, service, runtime };
}
async function completed(service, id, condition = (v) => v.status === "ready") {
  for (let i = 0; i < 30; i++) {
    await service.tick();
    const value = await service.get(owner, id);
    if (condition(value)) return value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Original fixture did not complete");
}

test("daily seeds use trusted transcript/part/title and preserve explicit blocked states", async (t) => {
  const { service, library } = await fixture(t);
  const record = attempt();
  const seed = await service.seed(owner, record);
  assert.equal(seed.source.title, "Riverside learning centre · 听力体验");
  assert.equal(seed.source.part, 1);
  assert.match(seed.source.transcript, /club/i);
  assert.equal(seed.status, "pending");
  assert.deepEqual(
    await service.ensure(owner, record),
    await service.ensure(owner, record),
  );
  assert.equal((await service.list(owner)).lessons.length, 1);
  const missing = await seedDailyLesson(
    {
      ...library,
      getItem: async () => ({
        kind: "listening",
        title: "Original incomplete",
        data: { listenContent: "A".repeat(100) },
      }),
    },
    owner,
    "demo",
    attempt(),
    true,
  );
  assert.equal(missing.status, "blocked");
  assert.equal(missing.source.part, null);
  const unavailable = await seedDailyLesson(
    library,
    owner,
    "demo",
    attempt(),
    false,
  );
  assert.equal(unavailable.status, "blocked");
  assert.match(unavailable.error, /尚未配置/);
  const unknown = await seedDailyLesson(
    library,
    owner,
    "demo",
    attempt({ itemId: "missing" }),
    true,
  );
  assert.equal(unknown.status, "blocked");
  assert.equal(await service.seed(owner, attempt({ kind: "reading" })), null);
});

test("shared-store workers lease voice stages and append one transcription turn", async (t) => {
  const { service, runtime, library, root } = await fixture(t);
  const second = createDaily({
    store: service.storage,
    root,
    library,
    ownerId: owner,
    runtimeClient: runtime,
    pollInterval: 1000000,
  });
  t.after(() => second.close());
  await new Promise((resolve) => setImmediate(resolve));
  const seed = await service.ensure(owner, attempt());
  let lesson = await completed(service, seed.id);
  let started, release;
  const began = new Promise((resolve) => {
    started = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  runtime.transcribe = async () => {
    calls++;
    started();
    await gate;
    return { text: "I would join on Monday." };
  };
  const req = Readable.from([Buffer.from("original-concurrent-voice")]);
  req.headers = { "content-type": "audio/wav" };
  lesson = await service.upload(
    owner,
    seed.id,
    req,
    new URL(
      `http://local.invalid/?expectedVersion=${lesson.version}&requestId=${randomUUID()}&durationSeconds=3`,
    ),
  );
  const firstTick = service.tick();
  await began;
  await second.tick();
  assert.equal(calls, 1);
  release();
  await firstTick;
  lesson = await completed(second, seed.id, (value) => !value.pending);
  assert.equal(
    lesson.conversation.messages.filter((message) => message.role === "user")
      .length,
    1,
  );
  assert.equal(
    lesson.conversation.messages.filter(
      (message) => message.role === "assistant",
    ).length,
    2,
  );
  assert.equal(lesson.pending, null);
});

test("daily local entities isolate owner/mode and enforce CAS plus exact request replay", async (t) => {
  const { service, root } = await fixture(t);
  const lesson = await service.ensure(owner, attempt());
  const body = {
    expectedVersion: lesson.version,
    requestId: randomUUID(),
    section: "writing",
    text: "An original draft",
    level: "basic",
  };
  const saved = await service.action(owner, lesson.id, "draft", body);
  assert.equal(saved.version, 2);
  assert.equal(
    (await service.action(owner, lesson.id, "draft", body)).version,
    2,
  );
  await assert.rejects(
    service.action(owner, lesson.id, "draft", {
      ...body,
      text: "Another value",
    }),
    { status: 409 },
  );
  await assert.rejects(
    service.action(owner, lesson.id, "draft", {
      ...body,
      requestId: randomUUID(),
    }),
    { status: 409, currentVersion: 2 },
  );
  await assert.rejects(service.get(other, lesson.id), { status: 404 });
  assert.deepEqual(
    await createLocalDailyStore(root).listDaily(owner, "archive"),
    [],
  );
  const restarted = createLocalDailyStore(root);
  assert.equal(
    (await restarted.getDaily(owner, "demo", lesson.id)).writing.draft.text,
    "An original draft",
  );
  await fs.symlink(path.join(root, "outside"), path.join(root, "linked"));
  await assert.rejects(
    createLocalDailyStore(path.join(root, "linked")).listDaily(owner, "demo"),
  );
});

test("daily full-paper listening creates four distinct grouped lessons with verified part provenance", async (t) => {
  const { service } = await fixture(t);
  const paperRunId = randomUUID();
  for (let part = 1; part <= 4; part++) {
    const record = attempt({
      itemId: `paper-demo-listening-${part}`,
      answers: {
        __paperSession: JSON.stringify([
          "original-general-flow-demo",
          paperRunId,
        ]),
      },
    });
    const lesson = await service.ensure(owner, record);
    assert.equal(lesson.source.part, part);
    assert.equal(lesson.source.paperId, "original-general-flow-demo");
    assert.equal(lesson.source.paperRunId, paperRunId);
  }
  const lessons = (await service.list(owner)).lessons;
  assert.equal(new Set(lessons.map((value) => value.id)).size, 4);
  const forged = await service.ensure(
    owner,
    attempt({
      answers: {
        __paperSession: JSON.stringify(["untrusted-paper", paperRunId]),
      },
    }),
  );
  assert.equal(forged.source.paperId, null);
});

test("daily delivers five verified questions even when they share one type", async (t) => {
  const runtime = fakeRuntime({
    output: (output) => {
      for (const question of output.reading.questions) {
        question.kind = "choice";
        question.options = ["Monday", "Tuesday", "Friday"];
      }
    },
  });
  const { service } = await fixture(t, runtime);
  const seed = await service.ensure(owner, attempt());
  const lesson = await completed(service, seed.id);
  assert.equal(lesson.content.reading.questions.length, 5);
  assert.deepEqual(
    [
      ...new Set(
        lesson.content.reading.questions.map((question) => question.kind),
      ),
    ],
    ["choice"],
  );
  assert(
    lesson.content.reading.questions.every(
      (question) => question.answer === undefined,
    ),
  );
});

for (const count of [3, 4]) {
  test(`daily still rejects a generated lesson with only ${count} valid questions`, async (t) => {
    const { service } = await fixture(
      t,
      fakeRuntime({
        output: (output) => {
          output.reading.questions.length = count;
        },
      }),
    );
    const seed = await service.ensure(owner, attempt());
    const lesson = await completed(
      service,
      seed.id,
      (value) => value.status === "failed",
    );
    assert.equal(lesson.content, null);
    assert.match(lesson.error, /至少 5/);
  });
}

test("daily generation hides keys until deterministic reading grading and rejects unsupported evidence", async (t) => {
  const { service, runtime } = await fixture(t);
  const seed = await service.ensure(owner, attempt());
  let lesson = await completed(service, seed.id);
  assert.equal(lesson.content.reading.questions.length, 5);
  for (const q of lesson.content.reading.questions) {
    assert.equal(q.answer, undefined);
    assert.equal(q.evidence, undefined);
    assert.equal(q.explanation, undefined);
  }
  assert.equal(runtime.calls[0].workflow, "ielts.lesson");
  assert.equal(runtime.calls[0].input.source.part, 1);
  assert.equal(runtime.calls[0].input.source.item_id, "demo-listening");
  const body = {
    expectedVersion: lesson.version,
    requestId: randomUUID(),
    answers: {
      q0: " Monday ",
      q1: "wrong",
      q2: "Monday",
      q3: "Monday",
      q4: "Monday",
    },
  };
  lesson = await service.action(owner, seed.id, "reading", body);
  assert.equal(lesson.reading.attempts[0].score, 4);
  assert.equal(lesson.content.reading.questions[0].answer, "Monday");
  assert.equal(
    (await service.action(owner, seed.id, "reading", body)).reading.attempts
      .length,
    1,
  );
  const invalid = fakeRuntime({
    output: (value) => {
      if (value.reading)
        value.reading.questions[0].evidence =
          "Evidence invented outside the transcript";
    },
  });
  const second = await fixture(t, invalid);
  const bad = await second.service.ensure(owner, attempt());
  const failed = await completed(
    second.service,
    bad.id,
    (v) => v.status === "failed",
  );
  assert.equal(failed.content, null);
  assert.match(failed.error, /原文依据/);
});

test("daily persisted run IDs resume after service restart without another generation request", async (t) => {
  const runtime = fakeRuntime({ queued: true });
  const { service, root, library } = await fixture(t, runtime);
  const lesson = await service.ensure(owner, attempt());
  await completed(
    service,
    lesson.id,
    (value) => value.pending?.runId === "original-run",
  );
  service.close();
  const restarted = createDaily({
    root,
    library,
    ownerId: owner,
    runtimeClient: runtime,
    pollInterval: 1000000,
  });
  t.after(() => restarted.close());
  const ready = await completed(restarted, lesson.id);
  assert.equal(ready.status, "ready");
  assert.equal(runtime.calls.length, 1);
});

test("daily conversation, Chinese expression help and writing questions preserve drafts and feedback", async (t) => {
  const { service, runtime } = await fixture(t);
  const seed = await service.ensure(owner, attempt());
  let lesson = await completed(service, seed.id);
  const requestId = randomUUID();
  const body = {
    expectedVersion: lesson.version,
    requestId,
    text: "I enjoy learning with people.",
  };
  lesson = await service.action(owner, seed.id, "conversation", body);
  assert.equal(lesson.pending.kind, "conversation");
  assert.equal(
    (await service.action(owner, seed.id, "conversation", body)).conversation
      .messages.length,
    2,
  );
  await assert.rejects(
    service.action(owner, seed.id, "conversation", {
      ...body,
      expectedVersion: lesson.version,
      requestId: randomUUID(),
    }),
    { status: 409 },
  );
  lesson = await completed(service, seed.id, (value) => !value.pending);
  assert.equal(lesson.conversation.messages.length, 3);
  assert.equal(lesson.conversation.messages[2].outcome, "expressed");
  lesson = await service.action(owner, seed.id, "expression-help", {
    expectedVersion: lesson.version,
    requestId: randomUUID(),
    text: "我想加入俱乐部",
  });
  lesson = await completed(service, seed.id, (value) => !value.pending);
  assert.equal(lesson.expressionHelp.english, "I would like to join the club.");
  lesson = await service.action(owner, seed.id, "writing", {
    expectedVersion: lesson.version,
    requestId: randomUUID(),
    text: "I would join the club because I enjoy talking.",
    level: "basic",
    action: "ask",
    question: "如何补充原因？",
  });
  lesson = await completed(service, seed.id, (value) => !value.pending);
  assert.equal(lesson.writing.submissions[0].action, "ask");
  assert.equal(lesson.writing.submissions[0].feedback.task_complete, true);
  assert.equal(lesson.writing.discussion.length, 1);
  const writingCall = runtime.calls.find(
    (value) => value.workflow === "ielts.writing",
  );
  assert.equal(writingCall.input.action, "question");
  assert.equal(writingCall.input.received_help, true);
  assert.match(writingCall.input.text, /如何补充原因/);
  const expressionCall = runtime.calls.find(
    (value) => value.workflow === "ielts.expression",
  );
  assert.equal(
    expressionCall.input.history.at(-1).follow_up,
    "Why would you choose it?",
  );
  lesson = await service.action(owner, seed.id, "writing", {
    expectedVersion: lesson.version,
    requestId: randomUUID(),
    text: "Here is my revised draft.",
    level: "basic",
    action: "attempt",
  });
  await completed(service, seed.id, (value) => !value.pending);
  const secondWriting = runtime.calls
    .filter((value) => value.workflow === "ielts.writing")
    .at(-1);
  assert.match(secondWriting.input.history[0].text, /如何补充原因/);
  assert.equal(secondWriting.input.history[1].feedback.task_complete, true);
  assert.equal(
    secondWriting.input.history.some((value) => value.follow_up),
    false,
  );
});

test("daily feedback failure can be retried without another student message", async (t) => {
  const config = {};
  const runtime = fakeRuntime(config);
  const { service } = await fixture(t, runtime);
  const seed = await service.ensure(owner, attempt());
  let lesson = await completed(service, seed.id);
  config.fail = true;
  lesson = await service.action(owner, seed.id, "conversation", {
    expectedVersion: lesson.version,
    requestId: randomUUID(),
    text: "I like books.",
  });
  lesson = await completed(service, seed.id, (value) => !value.pending);
  assert.equal(lesson.status, "ready");
  assert.ok(lesson.error);
  assert.equal(lesson.conversation.messages.length, 2);
  config.fail = false;
  lesson = await service.action(owner, seed.id, "retry", {
    expectedVersion: lesson.version,
    requestId: randomUUID(),
  });
  lesson = await completed(service, seed.id, (value) => !value.pending);
  assert.equal(lesson.conversation.messages.length, 3);
  assert.equal(lesson.error, null);
});

test("daily conversation can finish and resume without losing history or accepting new replies while finished", async (t) => {
  const { service, root } = await fixture(t);
  const seed = await service.ensure(owner, attempt());
  let lesson = await completed(service, seed.id);
  assert.equal(lesson.conversation.status, "active");
  lesson = await service.action(owner, seed.id, "conversation", {
    expectedVersion: lesson.version,
    requestId: randomUUID(),
    text: "I enjoy the club.",
  });
  await assert.rejects(
    service.action(owner, seed.id, "conversation-state", {
      expectedVersion: lesson.version,
      requestId: randomUUID(),
      state: "finished",
    }),
    { status: 409 },
  );
  lesson = await completed(service, seed.id, (value) => !value.pending);
  const messages = structuredClone(lesson.conversation.messages);
  const finish = {
    expectedVersion: lesson.version,
    requestId: randomUUID(),
    state: "finished",
  };
  lesson = await service.action(owner, seed.id, "conversation-state", finish);
  assert.equal(lesson.conversation.status, "finished");
  assert.ok(lesson.conversation.completedAt);
  assert.deepEqual(lesson.conversation.messages, messages);
  assert.equal(
    (await service.action(owner, seed.id, "conversation-state", finish))
      .version,
    lesson.version,
  );
  for (const action of ["conversation", "expression-help"])
    await assert.rejects(
      service.action(owner, seed.id, action, {
        expectedVersion: lesson.version,
        requestId: randomUUID(),
        text: "Another reply",
      }),
      { status: 409 },
    );
  assert.equal(
    (await createLocalDailyStore(root).getDaily(owner, "demo", seed.id))
      .conversation.status,
    "finished",
  );
  lesson = await service.action(owner, seed.id, "conversation-state", {
    expectedVersion: lesson.version,
    requestId: randomUUID(),
    state: "active",
  });
  assert.equal(lesson.conversation.completedAt, undefined);
  assert.deepEqual(lesson.conversation.messages, messages);
  lesson = await service.action(owner, seed.id, "conversation", {
    expectedVersion: lesson.version,
    requestId: randomUUID(),
    text: "Here is another reason.",
  });
  lesson = await completed(service, seed.id, (value) => !value.pending);
  assert.equal(lesson.conversation.messages.length, messages.length + 2);
});

test("daily recognition-error preserves original audio and excludes both stable turn messages from future model context", async (t) => {
  const { service, runtime } = await fixture(t);
  const seed = await service.ensure(owner, attempt());
  let lesson = await completed(service, seed.id);
  const recordingRequestId = randomUUID();
  const req = Readable.from([Buffer.from("original-recognition-test-audio")]);
  req.headers = { "content-type": "audio/webm" };
  lesson = await service.upload(
    owner,
    seed.id,
    req,
    new URL(
      `http://local.invalid/?expectedVersion=${lesson.version}&requestId=${recordingRequestId}&durationSeconds=4`,
    ),
  );
  await assert.rejects(
    service.action(owner, seed.id, "recognition-error", {
      expectedVersion: lesson.version,
      requestId: randomUUID(),
      messageId: recordingRequestId,
    }),
    { status: 409 },
  );
  lesson = await completed(service, seed.id, (value) => !value.pending);
  const userMessage = structuredClone(lesson.conversation.messages[1]);
  const teacherMessage = structuredClone(lesson.conversation.messages[2]);
  const marker = {
    expectedVersion: lesson.version,
    requestId: randomUUID(),
    messageId: userMessage.id,
  };
  lesson = await service.action(owner, seed.id, "recognition-error", marker);
  assert.equal(lesson.conversation.messages[1].text, userMessage.text);
  assert.equal(lesson.conversation.messages[1].audioUrl, userMessage.audioUrl);
  assert.equal(lesson.conversation.messages[1].excluded, true);
  assert.equal(lesson.conversation.messages[2].text, teacherMessage.text);
  assert.equal(lesson.conversation.messages[2].excluded, true);
  assert.equal(
    (await service.action(owner, seed.id, "recognition-error", marker)).version,
    lesson.version,
  );
  const savedAudio = await service.audio(
    owner,
    seed.id,
    lesson.recordings[0].id,
  );
  assert.equal(
    (await fs.readFile(savedAudio.target)).toString(),
    "original-recognition-test-audio",
  );
  lesson = await service.action(owner, seed.id, "expression-help", {
    expectedVersion: lesson.version,
    requestId: randomUUID(),
    text: "请帮我表达真正的意思",
  });
  lesson = await completed(service, seed.id, (value) => !value.pending);
  const help = runtime.calls
    .filter((value) => value.workflow === "ielts.expression")
    .at(-1);
  assert.equal(help.input.history.length, 1);
  const newRequestId = randomUUID();
  lesson = await service.action(owner, seed.id, "conversation", {
    expectedVersion: lesson.version,
    requestId: newRequestId,
    text: "This is my intended meaning.",
  });
  lesson = await completed(service, seed.id, (value) => !value.pending);
  const nextTurn = runtime.calls
    .filter((value) => value.workflow === "ielts.conversation")
    .at(-1);
  assert.equal(nextTurn.input.history.length, 1);
  assert.equal(
    nextTurn.input.history[0].text,
    lesson.content.conversation.opening,
  );
  await assert.rejects(
    service.action(owner, seed.id, "recognition-error", {
      expectedVersion: lesson.version,
      requestId: randomUUID(),
      messageId: newRequestId,
    }),
    { status: 400 },
  );
  await assert.rejects(
    service.action(owner, seed.id, "recognition-error", {
      expectedVersion: lesson.version,
      requestId: randomUUID(),
      messageId: teacherMessage.id,
    }),
    { status: 400 },
  );
});

test("daily voice persists private audio before ASR, replays upload idempotently and limits TTS to saved teacher messages", async (t) => {
  const { service, runtime } = await fixture(t);
  const seed = await service.ensure(owner, attempt());
  let lesson = await completed(service, seed.id);
  const requestId = randomUUID();
  const parameters = new URL(
    `http://local.invalid/?expectedVersion=${lesson.version}&requestId=${requestId}&durationSeconds=3`,
  );
  const upload = () => {
    const req = Readable.from([Buffer.from("original-test-recording")]);
    req.headers = { "content-type": "audio/webm;codecs=opus" };
    return service.upload(owner, seed.id, req, parameters);
  };
  lesson = await upload();
  assert.equal(lesson.recordings.length, 1);
  const file = await service.audio(owner, seed.id, lesson.recordings[0].id);
  assert.equal(
    (await fs.readFile(file.target)).toString(),
    "original-test-recording",
  );
  assert.equal(runtime.calls.filter((v) => v.speech).length, 0);
  assert.equal((await upload()).recordings.length, 1);
  lesson = await completed(service, seed.id, (value) => !value.pending);
  assert.equal(
    lesson.conversation.messages[1].recordingId,
    lesson.recordings[0].id,
  );
  assert.equal(
    lesson.conversation.messages[1].text,
    "I would join the conversation club.",
  );
  await assert.rejects(service.audio(other, seed.id, lesson.recordings[0].id), {
    status: 404,
  });
  await assert.rejects(
    service.action(owner, seed.id, "speech", {
      expectedVersion: lesson.version,
      requestId: randomUUID(),
      messageId: lesson.conversation.messages[1].id,
      text: "untrusted arbitrary text",
    }),
    { status: 400 },
  );
  const teacher = lesson.conversation.messages.at(-1);
  lesson = await service.action(owner, seed.id, "speech", {
    expectedVersion: lesson.version,
    requestId: randomUUID(),
    messageId: teacher.id,
    text: "untrusted arbitrary text",
  });
  lesson = await completed(service, seed.id, (value) => !value.pending);
  assert.ok(lesson.conversation.messages.at(-1).audioUrl);
  const speech = runtime.calls.find((v) => v.speech === "synthesize");
  assert.equal(speech.text, `${teacher.text}\n${teacher.followUp}`);
  assert.equal(speech.text.includes("untrusted"), false);
});

test("daily HTTP creates only explicitly submitted local attempts, preserves progress, and rejects cross-origin writes", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ielts-daily-http-original-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = await createApp({
    projectRoot: root,
    forceDemo: true,
    env: {},
    runtimeClient: fakeRuntime(),
    dailyPollInterval: 1000000,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        app.server.closeAllConnections();
        app.server.close(resolve);
      }),
  );
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const historical = attempt();
  const progress = {
    attempts: [historical],
    drafts: { preserved: { text: "An original draft" } },
    notes: {},
    bookmarks: [],
  };
  assert.equal(
    (
      await fetch(base + "/api/progress", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(progress),
      })
    ).status,
    200,
  );
  assert.equal(
    (await (await fetch(base + "/api/daily")).json()).lessons.length,
    0,
  );
  const record = attempt();
  progress.attempts.unshift(record);
  assert.equal(
    (
      await fetch(base + "/api/progress", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-IELTS-New-Attempts": record.id,
        },
        body: JSON.stringify(progress),
      })
    ).status,
    200,
  );
  const list = await (await fetch(base + "/api/daily")).json();
  assert.equal(list.lessons.length, 1);
  assert.equal(list.lessons[0].attemptId, record.id);
  assert.equal(
    (await (await fetch(base + "/api/progress")).json()).drafts.preserved.text,
    "An original draft",
  );
  assert.equal(
    (
      await fetch(base + `/api/daily/${list.lessons[0].id}/draft`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://cross-origin.invalid",
        },
        body: JSON.stringify({}),
      })
    ).status,
    403,
  );
});

test("runtime client keeps owner/token on internal requests and rejects redirects or oversized responses", async () => {
  const seen = [];
  const client = createRuntimeClient(
    {
      IELTS_RUNTIME_URL: "http://runtime.invalid",
      IELTS_RUNTIME_TOKEN: "original-test-token-only",
    },
    async (url, init) => {
      seen.push({ url, init });
      return new Response(
        JSON.stringify({ id: "run-original", status: "running" }),
      );
    },
  );
  await client.start(owner, { workflow: "ielts.lesson" });
  await client.get(owner, "run-original");
  assert.equal(seen[0].init.headers["X-Owner-Id"], owner);
  assert.equal(seen[0].init.redirect, "error");
  assert.equal(seen[1].init.method, "GET");
  client.close();
  const disabled = createRuntimeClient({});
  await assert.rejects(disabled.start(owner, {}), { status: 503 });
});

test("daily and PostgreSQL shutdown share completion promises and wait for active work", async (t) => {
  let releasePool,
    poolEnded = false;
  const poolGate = new Promise((resolve) => {
    releasePool = resolve;
  });
  const store = new PostgresStore({
    pool: {
      end: async () => {
        await poolGate;
        poolEnded = true;
      },
    },
  });
  store.ownsPool = true;
  const firstPoolClose = store.close();
  assert.equal(store.close(), firstPoolClose);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(poolEnded, false);
  releasePool();
  await firstPoolClose;
  assert.equal(poolEnded, true);

  let started,
    releaseRun,
    activeFinished = false;
  const startedGate = new Promise((resolve) => {
    started = resolve;
  });
  const runGate = new Promise((resolve) => {
    releaseRun = resolve;
  });
  const runtime = fakeRuntime();
  runtime.start = async () => {
    started();
    await runGate;
    activeFinished = true;
    return { id: "original-shutdown-run", status: "running" };
  };
  const { service } = await fixture(t, runtime);
  await service.ensure(owner, attempt());
  const tick = service.tick();
  await startedGate;
  const firstDailyClose = service.close();
  assert.equal(service.close(), firstDailyClose);
  let closed = false;
  void firstDailyClose.then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  assert.equal(activeFinished, false);
  releaseRun();
  await firstDailyClose;
  await tick;
  assert.equal(activeFinished, true);
  assert.equal(closed, true);
});

test("local enqueue failure preserves the attempt and keeps the submission retryable", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ielts-daily-enqueue-original-"),
  );
  const app = await createApp({
    projectRoot: root,
    forceDemo: true,
    env: {},
    runtimeClient: fakeRuntime(),
    dailyPollInterval: 1000000,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await app.daily.close();
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const record = attempt(),
    progress = { attempts: [record], bookmarks: [], drafts: {}, notes: {} };
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const ensure = app.daily.ensure;
  app.daily.ensure = async () => {
    throw new Error("Original simulated temporary disk error");
  };
  const submit = () =>
    fetch(url + "/api/progress", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-IELTS-New-Attempts": record.id,
      },
      body: JSON.stringify(progress),
    });
  assert.equal((await submit()).status, 503);
  assert.equal(
    (await (await fetch(url + "/api/progress")).json()).attempts[0].id,
    record.id,
  );
  app.daily.ensure = ensure;
  assert.equal((await submit()).status, 200);
  assert.equal(
    (await (await fetch(url + "/api/daily")).json()).lessons.length,
    1,
  );
});

test("teacher audio committed before a crash is reused without another synthesis", async (t) => {
  const { service, runtime, library, root } = await fixture(t);
  const seed = await service.ensure(owner, attempt());
  let lesson = await completed(service, seed.id);
  const requestId = randomUUID();
  lesson = await service.action(owner, seed.id, "speech", {
    expectedVersion: lesson.version,
    requestId,
    messageId: lesson.conversation.messages[0].id,
  });
  const audio = createDailyAudio(path.join(root, "audio"));
  const saved = await audio.save(
    owner,
    library.mode,
    seed.id,
    requestId,
    "teacher",
    "audio/wav",
    [Buffer.from("original-already-generated-audio")],
  );
  runtime.synthesize = async () => {
    throw new Error("Synthesis must not run again after the file committed");
  };
  lesson = await completed(service, seed.id, (value) => !value.pending);
  const file = await service.audio(owner, seed.id, saved.id);
  assert.equal(
    (await fs.readFile(file.target)).toString(),
    "original-already-generated-audio",
  );
  assert.ok(
    lesson.conversation.messages[0].audioUrl.endsWith(`${saved.id}/audio`),
  );
});
