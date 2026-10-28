import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createDailyAudio } from "./daily-audio.mjs";
import {
  parseTranscript,
  buildGroups,
  gradeGroups,
  normalizeAnswer,
} from "../../apps/web/src/lib/questions.mjs";

const failure = (status, message, extra = {}) =>
  Object.assign(new Error(message), { status, ...extra });
const object = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const hash = (v) => createHash("sha256").update(v).digest("hex");
const stamp = () => new Date().toISOString();
const clone = (v) => structuredClone(v);
const idPattern = /^daily-[a-f0-9]{40}$/;
const requestPattern = /^[a-zA-Z0-9_-]{8,100}$/;
const safeText = (v, max = 20000) =>
  typeof v === "string" && v.length <= max && !v.includes("\0");
const maxEntity = 2 * 1024 * 1024;

/** One atomic file per lesson. User answers never enter the source archive. */
export function createLocalDailyStore(root) {
  if (!path.isAbsolute(root)) throw new Error("DAILY_ROOT 必须是绝对路径");
  let queue = Promise.resolve();
  const directory = (userId, mode) => {
    if (!/^[a-f0-9-]{36}$/i.test(userId) || !["demo", "archive"].includes(mode))
      throw failure(400, "学习身份无效");
    return path.join(root, userId, mode);
  };
  async function safeDirectory(userId, mode) {
    const target = directory(userId, mode);
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    for (const candidate of [root, path.join(root, userId), target])
      if ((await fs.lstat(candidate)).isSymbolicLink())
        throw failure(403, "课程目录不能是符号链接");
    const canonicalTarget = path.join(await fs.realpath(root), userId, mode);
    if ((await fs.realpath(target)) !== canonicalTarget)
      throw failure(403, "课程目录不被允许");
    return canonicalTarget;
  }
  async function read(userId, mode, id) {
    if (!idPattern.test(id)) throw failure(404, "课程不存在");
    const file = path.join(await safeDirectory(userId, mode), `${id}.json`);
    try {
      const handle = await fs.open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        if ((await handle.stat()).size > maxEntity)
          throw failure(500, "课程记录过大");
        return JSON.parse(await handle.readFile("utf8"));
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  async function write(userId, mode, value) {
    const dir = await safeDirectory(userId, mode);
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > maxEntity)
      throw failure(413, "课程记录超过容量限制");
    const temporary = path.join(dir, `.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(json);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, path.join(dir, `${value.id}.json`));
    } finally {
      await handle?.close();
      await fs.unlink(temporary).catch(() => {});
    }
  }
  const serialize = (operation) => {
    const work = queue.then(operation);
    queue = work.catch(() => {});
    return work;
  };
  return {
    async listDaily(userId, mode) {
      await queue;
      const entries = await fs.readdir(await safeDirectory(userId, mode), {
        withFileTypes: true,
      });
      const lessons = [];
      for (const entry of entries)
        if (entry.isFile() && /^daily-[a-f0-9]{40}\.json$/.test(entry.name)) {
          const value = await read(userId, mode, entry.name.slice(0, -5));
          if (value) lessons.push(value);
        }
      return lessons.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async getDaily(userId, mode, id) {
      await queue;
      return read(userId, mode, id);
    },
    ensureDaily(userId, mode, seed) {
      return serialize(async () => {
        const existing = await read(userId, mode, seed.id);
        if (existing) return existing;
        await write(userId, mode, seed);
        return seed;
      });
    },
    mutateDaily(userId, mode, id, change) {
      return serialize(async () => {
        const existing = await read(userId, mode, id);
        if (!existing) throw failure(404, "课程不存在");
        const next = await change(clone(existing));
        if (!next) return existing;
        next.version = existing.version + 1;
        next.updatedAt = stamp();
        await write(userId, mode, next);
        return next;
      });
    },
  };
}

export function createRuntimeClient(env = process.env, fetcher = fetch) {
  let base;
  if (env.IELTS_RUNTIME_URL) {
    base = new URL(env.IELTS_RUNTIME_URL);
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw new Error("IELTS_RUNTIME_URL 必须是没有凭据的 HTTP 服务地址");
  }
  const configured = !!(base && env.IELTS_RUNTIME_TOKEN);
  const controllers = new Set();
  async function speech(endpoint, ownerId, body, contentType, binary = false) {
    if (!configured) throw failure(503, "语音服务尚未配置");
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 100000);
    timeout.unref();
    try {
      const response = await fetcher(
        `${base.href.replace(/\/$/, "")}${endpoint}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.IELTS_RUNTIME_TOKEN}`,
            "X-Owner-Id": ownerId,
            "Content-Type": contentType,
          },
          body,
          signal: controller.signal,
          redirect: "error",
        },
      );
      if (!response.ok)
        throw failure(503, "语音服务暂不可用，录音与文字已保留");
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 32 * 1024 * 1024) {
          await reader.cancel();
          throw failure(502, "语音返回内容过大");
        }
        chunks.push(Buffer.from(value));
      }
      const bytes = Buffer.concat(chunks);
      return binary
        ? {
            bytes,
            contentType: response.headers.get("content-type") || "audio/mpeg",
          }
        : JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      if (error.status) throw error;
      throw failure(503, "语音服务连接失败，已保存的练习不受影响");
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
    }
  }
  async function request(endpoint, ownerId, body) {
    if (!configured) throw failure(503, "AI 服务尚未配置，作答与课程已保存");
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 15000);
    timeout.unref();
    try {
      const response = await fetcher(
        `${base.href.replace(/\/$/, "")}${endpoint}`,
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Authorization: `Bearer ${env.IELTS_RUNTIME_TOKEN}`,
            "X-Owner-Id": ownerId,
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
          redirect: "error",
        },
      );
      if (!response.ok) throw failure(503, "AI 服务暂不可用，请稍后重试");
      const reader = response.body.getReader();
      let size = 0;
      const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxEntity) {
          await reader.cancel();
          throw failure(502, "AI 返回内容过大");
        }
        chunks.push(Buffer.from(value));
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      if (error.status) throw error;
      throw failure(503, "AI 服务连接失败，已保存的练习不受影响");
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
    }
  }
  return {
    configured,
    capabilities: (owner) => request("/capabilities", owner),
    start: (owner, body) => request("/runs", owner, body),
    get: (owner, id) => request(`/runs/${encodeURIComponent(id)}`, owner),
    transcribe: (owner, bytes, contentType) =>
      speech("/speech/transcribe", owner, bytes, contentType),
    synthesize: (owner, text) =>
      speech(
        "/speech/synthesize",
        owner,
        JSON.stringify({ text }),
        "application/json",
        true,
      ),
    close() {
      for (const controller of controllers) controller.abort();
    },
  };
}

function sourceForRuntime(source) {
  return {
    item_id: source.itemId,
    title: source.title,
    transcript: source.transcript,
    part: source.part,
    ...(source.paperRunId ? { paper_run_id: source.paperRunId } : {}),
  };
}

function conversationHistory(messages) {
  return messages
    .filter((message) => !message.excluded)
    .slice(-100)
    .map(({ role, text, feedback, followUp }) => ({
      role,
      text,
      ...(feedback ? { feedback } : {}),
      ...(followUp ? { follow_up: followUp } : {}),
    }));
}
function writingHistory(writing) {
  return writing.submissions
    .flatMap((submission) => [
      {
        role: "user",
        text: [
          submission.text,
          submission.question ? `Question: ${submission.question}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        level: submission.level,
        action: submission.action,
      },
      ...(submission.feedback
        ? [
            {
              role: "assistant",
              text: submission.feedback.feedback_zh,
              feedback: submission.feedback,
            },
          ]
        : []),
    ])
    .slice(-100);
}

export async function seedDailyLesson(
  library,
  ownerId,
  mode,
  attempt,
  configured,
) {
  if (attempt.kind !== "listening") return null;
  const createdAt = stamp();
  const id = `daily-${hash(`${ownerId}\0${mode}\0${attempt.id}`).slice(0, 40)}`;
  const source = {
    itemId: attempt.itemId,
    title: attempt.title,
    part: null,
    transcript: "",
    paperId: null,
    paperRunId: null,
  };
  let reason = "";
  try {
    const item = await library.getItem(attempt.itemId);
    if (!item || item.kind !== "listening")
      reason = "听力材料不存在，无法生成课程";
    else {
      const data = item.data?.data?.questions
        ? item.data.data
        : item.data || {};
      source.title = item.title;
      source.part = [1, 2, 3, 4].includes(Number(data.part))
        ? Number(data.part)
        : null;
      const lines = parseTranscript(
        data.listenDetail,
        Number(data.seconds) || 0,
      );
      source.transcript = lines.length
        ? lines.map((line) => line.text).join("\n")
        : typeof data.listenContent === "string"
          ? data.listenContent.replace(/<[^>]*>/g, "").trim()
          : "";
      source.transcriptHash = hash(source.transcript);
      source.audioUrl =
        typeof data.audioUrl === "string" && data.audioUrl.startsWith("/media/")
          ? data.audioUrl
          : null;
      source.lines = lines.map(({ text, start, end }) => ({
        text,
        start,
        end,
      }));
      source.grade = gradeGroups(buildGroups(data), attempt.answers || {});
      try {
        const marker = JSON.parse(attempt.answers?.__paperSession || "null");
        if (
          Array.isArray(marker) &&
          marker.length === 2 &&
          marker.every((v) => safeText(v, 200))
        ) {
          const paper = await library.getPaper(marker[0]);
          if (paper?.listeningIds.includes(item.id)) {
            source.paperId = marker[0];
            source.paperRunId = marker[1];
          }
        }
      } catch {
        /* A browser-supplied paper marker is only accepted after library lookup. */
      }
      if (source.transcript.length < 80 || source.transcript.length > 40000) {
        reason = "这份听力原文长度不符合要求（80 至 40000 字符）";
        if (source.transcript.length > 40000) {
          source.transcript = "";
          source.lines = [];
        }
      } else if (!source.part)
        reason = "这份听力的 Part 编号未知，请先补充材料元数据";
    }
  } catch {
    reason = "听力材料暂时无法读取，作答已保存";
  }
  if (!reason && !configured) reason = "AI 服务尚未配置，作答与课程已保存";
  return {
    id,
    attemptId: attempt.id,
    version: 1,
    status: reason ? "blocked" : "pending",
    source,
    targetBand: 6.5,
    content: null,
    reading: { attempts: [], draft: { answers: {} } },
    conversation: { status: "active", messages: [], draft: { text: "" } },
    writing: {
      draft: { text: "", level: "basic" },
      submissions: [],
      discussion: [],
    },
    expressionHelp: null,
    recordings: [],
    _assets: [],
    failedJob: null,
    pending: reason
      ? null
      : {
          kind: "generation",
          requestId: "generation-1",
          revision: 1,
          state: "pending",
          runId: null,
          failures: 0,
        },
    generationRevision: 1,
    error: reason || null,
    _requests: {},
    createdAt,
    updatedAt: createdAt,
  };
}

function validateContent(value, source) {
  if (
    !object(value) ||
    !safeText(value.title, 500) ||
    !object(value.reading) ||
    value.reading.passage !== source.transcript ||
    !safeText(value.reading.translation, 200000)
  )
    throw failure(502, "生成课程未通过原文核验");
  const questions = value.reading.questions;
  if (
    !Array.isArray(questions) ||
    questions.length < 5 ||
    questions.length > 14 ||
    new Set(questions.map((q) => q.kind)).size < 2 ||
    new Set(questions.map((q) => q.id)).size !== questions.length
  )
    throw failure(502, "阅读题目数量或题型不符合要求");
  for (const q of questions) {
    if (
      !object(q) ||
      !safeText(q.id, 100) ||
      !q.id ||
      !["choice", "true_false", "gap"].includes(q.kind) ||
      !safeText(q.prompt, 3000) ||
      !safeText(q.answer, 1000) ||
      !q.answer ||
      !safeText(q.evidence, 10000) ||
      !q.evidence ||
      !source.transcript.includes(q.evidence) ||
      !safeText(q.explanation, 6000) ||
      !Array.isArray(q.options) ||
      q.options.length > 5 ||
      !q.options.every((v) => safeText(v, 1000)) ||
      new Set(q.options).size !== q.options.length ||
      !Number.isInteger(q.max_words) ||
      q.max_words < 1 ||
      q.max_words > 5 ||
      (q.kind === "choice" &&
        (q.options.length < 3 || !q.options.includes(q.answer))) ||
      (q.kind === "true_false" &&
        (JSON.stringify(q.options) !==
          JSON.stringify(["True", "False", "Not Given"]) ||
          !q.options.includes(q.answer))) ||
      (q.kind === "gap" &&
        (q.options.length !== 0 ||
          q.answer.trim().split(/\s+/).length > q.max_words))
    )
      throw failure(502, "阅读题目缺少可信答案或原文依据");
  }
  if (
    !object(value.conversation) ||
    !safeText(value.conversation.topic, 1000) ||
    !safeText(value.conversation.opening, 6000) ||
    !safeText(value.conversation.opening_zh, 6000) ||
    !Array.isArray(value.conversation.starters) ||
    value.conversation.starters.length > 10 ||
    !value.conversation.starters.every((v) => safeText(v, 1000))
  )
    throw failure(502, "交流主题格式不正确");
  if (
    !object(value.writing) ||
    !Array.isArray(value.writing.tasks) ||
    value.writing.tasks.length !== 3 ||
    !["basic", "extension", "challenge"].every((level) =>
      value.writing.tasks.some(
        (task) =>
          task.level === level &&
          safeText(task.instruction, 6000) &&
          safeText(task.goal, 3000) &&
          Array.isArray(task.hints) &&
          task.hints.every((v) => safeText(v, 3000)),
      ),
    )
  )
    throw failure(502, "写作任务格式不正确");
  return clone(value);
}

function publicLesson(lesson, capabilities) {
  const result = clone(lesson);
  delete result._requests;
  delete result._assets;
  delete result.failedJob;
  result.conversation.status ||= "active";
  if (result.pending) {
    delete result.pending.input;
    delete result.pending.lease;
    delete result.pending.failures;
    delete result.pending.notBefore;
  }
  // Answers are revealed only after this owner submits the reading exercise.
  if (result.content && !result.reading.attempts.length)
    result.content.reading.questions = result.content.reading.questions.map(
      ({ answer, evidence, explanation, ...question }) => question,
    );
  result.capabilities = capabilities;
  return result;
}

function validateRequest(body) {
  if (
    !object(body) ||
    !Number.isSafeInteger(body.expectedVersion) ||
    body.expectedVersion < 1 ||
    !requestPattern.test(body.requestId || "")
  )
    throw failure(400, "需要课程版本与有效 requestId");
  if (Buffer.byteLength(JSON.stringify(body)) > 100000)
    throw failure(413, "练习内容过大");
}

export function createDaily({
  library,
  store,
  root,
  env = process.env,
  ownerId = "00000000-0000-4000-8000-000000000001",
  runtimeClient,
  pollInterval = 1500,
} = {}) {
  const mode = library.mode;
  const storage = store || createLocalDailyStore(root);
  const runtime = runtimeClient || createRuntimeClient(env);
  const audio = createDailyAudio(path.join(root, "audio"));
  const configured = runtime.configured !== false;
  let capabilities = { runtime: configured, asr: false, tts: false };
  let busy = false,
    closed = false,
    capabilityCheckedAt = 0;
  let activeTick = Promise.resolve(),
    closePromise;
  const seed = (userId, attempt) =>
    seedDailyLesson(
      library,
      userId,
      mode,
      attempt,
      configured && capabilities.runtime,
    );
  const mutate = (userId, id, operation) =>
    storage.mutateDaily(userId, mode, id, operation);
  async function refreshCapabilities() {
    if (
      !configured ||
      !runtime.capabilities ||
      Date.now() - capabilityCheckedAt < 30000
    )
      return;
    capabilityCheckedAt = Date.now();
    try {
      const value = await runtime.capabilities(ownerId);
      capabilities = {
        runtime: !!value.model,
        asr: !!value.asr,
        tts: !!value.tts,
      };
    } catch {
      /* A transient outage does not discard queued work. */
    }
  }
  async function processJob(userId, lesson) {
    let pending = lesson.pending;
    if (!pending || (pending.notBefore && pending.notBefore > Date.now()))
      return;
    const key = pending.requestId;
    const matches = (value) =>
      value.pending?.requestId === key &&
      value.pending.kind === pending.kind &&
      value.pending.revision === pending.revision;
    const current = await storage.getDaily(userId, mode, lesson.id);
    if (!current || !matches(current)) return;
    let leaseToken;
    if (["transcription", "speech"].includes(pending.kind)) {
      leaseToken = randomUUID();
      const claimed = await mutate(userId, lesson.id, (value) => {
        if (!matches(value) || value.pending.lease?.expiresAt > Date.now())
          return null;
        value.pending.lease = {
          token: leaseToken,
          expiresAt: Date.now() + 120000,
        };
        return value;
      });
      if (claimed.pending?.lease?.token !== leaseToken) return;
      lesson = claimed;
      pending = claimed.pending;
    }
    const commit = (operation) =>
      mutate(userId, lesson.id, (value) => {
        if (
          !matches(value) ||
          (leaseToken && value.pending.lease?.token !== leaseToken)
        )
          return null;
        return operation(value);
      });
    try {
      if (pending.kind === "transcription") {
        const asset = lesson._assets.find(
          (value) => value.id === pending.assetId,
        );
        const file = await audio.file(userId, mode, lesson.id, asset);
        const output = await runtime.transcribe(
          userId,
          await fs.readFile(file.target),
          asset.contentType,
        );
        if (!safeText(output.text, 12000) || !output.text.trim())
          throw failure(502, "录音未识别到有效文字，录音已保存");
        await commit((value) => {
          if (value.pending?.requestId !== key) return null;
          const recording = value.recordings.find(
            (record) => record.id === pending.assetId,
          );
          recording.status = "transcribed";
          recording.text = output.text;
          value.conversation.messages.push({
            id: key,
            role: "user",
            text: output.text,
            recordingId: recording.id,
            audioUrl: recording.audioUrl,
            createdAt: stamp(),
          });
          value.pending = {
            kind: "conversation",
            requestId: key,
            state: "pending",
            runId: null,
            failures: 0,
            input: {
              source: sourceForRuntime(value.source),
              lesson: value.content,
              target_band: value.targetBand,
              text: output.text,
              history: conversationHistory(
                value.conversation.messages.filter(
                  (message) => message.id !== key,
                ),
              ),
              received_help: !!value.expressionHelp?.english,
            },
          };
          return value;
        });
        return;
      }
      if (pending.kind === "speech") {
        const message = lesson.conversation.messages.find(
          (value) =>
            value.id === pending.messageId && value.role === "assistant",
        );
        if (!message) throw failure(502, "老师消息不存在");
        const output = await runtime.synthesize(
          userId,
          [message.text, message.followUp].filter(Boolean).join("\n"),
        );
        const asset = await audio.save(
          userId,
          mode,
          lesson.id,
          key,
          "teacher",
          output.contentType,
          [output.bytes],
        );
        await commit((value) => {
          if (value.pending?.requestId !== key) return null;
          const saved = value.conversation.messages.find(
            (entry) => entry.id === pending.messageId,
          );
          value._assets.push(asset);
          saved.audioUrl = `/api/daily/${lesson.id}/recordings/${asset.id}/audio`;
          value.pending = null;
          value.failedJob = null;
          value.error = null;
          return value;
        });
        return;
      }
      let run;
      if (pending.runId) run = await runtime.get(userId, pending.runId);
      else {
        const input =
          pending.kind === "generation"
            ? {
                source: sourceForRuntime(lesson.source),
                target_band: lesson.targetBand,
              }
            : pending.input;
        const idempotencyKey =
          pending.kind === "generation"
            ? `lesson:${lesson.id}:${pending.revision}`
            : `lesson:${lesson.id}:${pending.kind}:${pending.revision || key}`;
        run = await runtime.start(userId, {
          owner_id: userId,
          workflow: {
            generation: "ielts.lesson",
            conversation: "ielts.conversation",
            expression: "ielts.expression",
            writing: "ielts.writing",
          }[pending.kind],
          version: "1",
          idempotency_key: idempotencyKey,
          input,
        });
      }
      if (!object(run) || !safeText(run.id, 200) || !run.id)
        throw failure(502, "AI 任务返回格式无效");
      await commit((value) => {
        if (value.pending?.requestId !== key) return null;
        if (["failed", "cancelled", "blocked"].includes(run.status)) {
          if (pending.kind === "generation") value.status = "failed";
          else if (pending.kind === "writing") {
            const submitted = value.writing.submissions.find(
              (v) => v.id === key,
            );
            if (submitted) submitted.status = "failed";
          }
          value.error = "AI 任务未完成，可重试；已保存的练习已保留";
          value.failedJob = value.pending;
          value.pending = null;
          return value;
        }
        if (!["completed", "succeeded", "complete"].includes(run.status)) {
          if (
            value.pending.runId === run.id &&
            value.pending.state === "running"
          )
            return null;
          value.pending.runId = run.id;
          value.pending.state = "running";
          if (pending.kind === "generation") value.status = "generating";
          return value;
        }
        const output = run.output;
        if (pending.kind === "generation") {
          value.content = validateContent(output, value.source);
          value.status = "ready";
          value.conversation.messages.push({
            id: `${key}-opening`,
            role: "assistant",
            text: value.content.conversation.opening,
            translation: value.content.conversation.opening_zh,
            createdAt: stamp(),
          });
        } else if (pending.kind === "conversation") {
          if (
            !object(output) ||
            !safeText(output.reply_en, 10000) ||
            !safeText(output.follow_up, 6000) ||
            !safeText(output.feedback_zh, 6000) ||
            !["expressed", "needs_support", "unclear"].includes(output.outcome)
          )
            throw failure(502, "交流反馈格式无效");
          value.conversation.messages.push({
            id: `${key}-reply`,
            role: "assistant",
            text: output.reply_en,
            followUp: output.follow_up,
            feedback: output.feedback_zh,
            outcome: output.outcome,
            createdAt: stamp(),
          });
        } else if (pending.kind === "expression") {
          if (
            !object(output) ||
            !!output.english === !!output.clarification_zh ||
            (output.english && !safeText(output.english, 10000)) ||
            (output.clarification_zh &&
              !safeText(output.clarification_zh, 6000))
          )
            throw failure(502, "表达帮助格式无效");
          value.expressionHelp = { ...output, id: key, createdAt: stamp() };
        } else if (pending.kind === "writing") {
          if (
            !object(output) ||
            !safeText(output.feedback_zh, 10000) ||
            !safeText(output.suggestion_en, 10000) ||
            !safeText(output.follow_up_zh, 6000) ||
            typeof output.task_complete !== "boolean" ||
            !Array.isArray(output.corrections) ||
            output.corrections.length > 100 ||
            !output.corrections.every(
              (v) =>
                object(v) &&
                safeText(v.original, 6000) &&
                safeText(v.corrected, 6000) &&
                safeText(v.reason_zh, 6000),
            )
          )
            throw failure(502, "写作反馈格式无效");
          const submission = value.writing.submissions.find(
            (v) => v.id === key,
          );
          if (submission) {
            submission.feedback = clone(output);
            submission.status = "completed";
          }
          if (pending.action === "ask")
            value.writing.discussion.push({
              id: key,
              question: pending.input.text,
              answer: output.follow_up_zh || output.feedback_zh,
              createdAt: stamp(),
            });
        }
        value.pending = null;
        value.failedJob = null;
        value.error = null;
        return value;
      });
    } catch (error) {
      if (closed) return;
      await commit((value) => {
        if (value.pending?.requestId !== key) return null;
        value.pending.failures = (value.pending.failures || 0) + 1;
        if (
          error.status === 502 ||
          value.pending.failures >= 3 ||
          !configured
        ) {
          if (pending.kind === "generation")
            value.status = configured ? "failed" : "blocked";
          const submission = value.writing.submissions.find(
            (v) => v.id === key,
          );
          if (submission) submission.status = "failed";
          value.failedJob = value.pending;
          value.pending = null;
          const recording = value.recordings.find(
            (v) => v.id === pending.assetId,
          );
          if (recording) recording.status = "failed";
        } else
          value.pending.notBefore =
            Date.now() + 1000 * 2 ** value.pending.failures;
        value.error = error.status
          ? error.message
          : "AI 服务暂不可用，已保存的练习不受影响";
        return value;
      });
    } finally {
      if (leaseToken)
        await mutate(userId, lesson.id, (value) => {
          if (value.pending?.lease?.token !== leaseToken) return null;
          delete value.pending.lease;
          return value;
        });
    }
  }
  async function workTick() {
    if (closed || busy) return;
    busy = true;
    try {
      await refreshCapabilities();
      for (const lesson of await storage.listDaily(ownerId, mode)) {
        if (closed) break;
        if (lesson.pending) await processJob(ownerId, lesson);
      }
    } catch {
      /* Later ticks recover persisted jobs after temporary storage/network errors. */
    } finally {
      busy = false;
    }
  }
  function tick() {
    if (closed || busy) return activeTick;
    activeTick = workTick();
    return activeTick;
  }
  const timer = setInterval(() => {
    void tick();
  }, pollInterval);
  timer.unref();
  queueMicrotask(() => {
    void tick();
  });
  const service = {
    seed,
    async ensure(userId, attempt) {
      const value = await seed(userId, attempt);
      return value ? storage.ensureDaily(userId, mode, value) : null;
    },
    async list(userId) {
      return {
        lessons: (await storage.listDaily(userId, mode)).map((v) =>
          publicLesson(v, capabilities),
        ),
        capabilities,
      };
    },
    async get(userId, id) {
      const value = await storage.getDaily(userId, mode, id);
      if (!value) throw failure(404, "课程不存在");
      return publicLesson(value, capabilities);
    },
    async action(userId, id, action, body) {
      validateRequest(body);
      const { expectedVersion, requestId, ...payload } = body;
      const fingerprint = hash(JSON.stringify({ action, payload }));
      const result = await mutate(userId, id, async (lesson) => {
        const previous = lesson._requests[requestId];
        if (previous) {
          if (previous !== fingerprint)
            throw failure(409, "相同 requestId 的内容不同，未覆盖原记录");
          return null;
        }
        if (lesson.version !== expectedVersion)
          throw failure(409, "课程已在另一窗口更新，请刷新后重试", {
            currentVersion: lesson.version,
          });
        if (Object.keys(lesson._requests).length >= 2000)
          throw failure(409, "这份课程已达到练习记录上限，请开始新的课程");
        if (action === "retry") {
          if (lesson.pending) throw failure(409, "任务正在处理，请稍后查看");
          if (lesson.content) {
            if (!lesson.failedJob) throw failure(409, "课程已生成，可继续练习");
            if (
              lesson.conversation.status === "finished" &&
              ["conversation", "expression", "transcription"].includes(
                lesson.failedJob.kind,
              )
            )
              throw failure(409, "本次交流已结束，请先选择继续交流");
            lesson.pending = {
              ...lesson.failedJob,
              revision: requestId,
              runId: null,
              state: "pending",
              failures: 0,
              notBefore: 0,
            };
            const submission = lesson.writing.submissions.find(
              (entry) => entry.id === lesson.pending.requestId,
            );
            if (submission) submission.status = "pending";
            lesson.error = null;
            lesson._requests[requestId] = fingerprint;
            return lesson;
          }
          if (!lesson.source.transcript || !lesson.source.part) {
            const attempt = {
              id: lesson.attemptId,
              itemId: lesson.source.itemId,
              title: lesson.source.title,
              kind: "listening",
              answers: {},
            };
            const refreshed = await seed(userId, attempt);
            lesson.source = refreshed.source;
          }
          if (
            lesson.source.transcript.length < 80 ||
            lesson.source.transcript.length > 40000 ||
            !lesson.source.part ||
            !configured
          ) {
            lesson.status = "blocked";
            lesson.error = !configured
              ? "AI 服务尚未配置，作答与课程已保存"
              : "材料原文或 Part 信息不完整";
          } else {
            lesson.generationRevision++;
            lesson.status = "pending";
            lesson.error = null;
            lesson.pending = {
              kind: "generation",
              requestId,
              revision: lesson.generationRevision,
              state: "pending",
              runId: null,
              failures: 0,
            };
          }
        } else if (action === "draft") {
          if (!["reading", "conversation", "writing"].includes(body.section))
            throw failure(400, "练习类别无效");
          if (body.section === "reading") {
            if (
              !object(body.answers) ||
              Object.keys(body.answers).length > 30 ||
              !Object.values(body.answers).every(
                (v) =>
                  safeText(v, 2000) ||
                  (Array.isArray(v) && v.every((s) => safeText(s, 2000))),
              )
            )
              throw failure(400, "阅读草稿格式无效");
            lesson.reading.draft = { answers: clone(body.answers) };
          } else {
            if (!safeText(body.text, 20000)) throw failure(400, "草稿文字无效");
            if (
              body.section === "writing" &&
              !["basic", "extension", "challenge"].includes(
                body.level || "basic",
              )
            )
              throw failure(400, "写作任务级别无效");
            lesson[body.section].draft = {
              text: body.text,
              ...(body.section === "writing"
                ? { level: body.level || "basic" }
                : {}),
            };
          }
        } else {
          if (lesson.status !== "ready" || !lesson.content)
            throw failure(409, "课程尚未准备好");
          if (action === "conversation-state") {
            if (!["active", "finished"].includes(body.state))
              throw failure(400, "交流状态无效");
            if (lesson.pending)
              throw failure(
                409,
                "上一条反馈正在生成，请等待完成后切换交流状态",
              );
            lesson.conversation.status = body.state;
            if (body.state === "finished")
              lesson.conversation.completedAt = stamp();
            else delete lesson.conversation.completedAt;
          } else if (action === "recognition-error") {
            if (lesson.pending)
              throw failure(409, "反馈正在生成，请等待完成后标记识别错误");
            const message = lesson.conversation.messages.find(
              (entry) => entry.id === body.messageId && entry.role === "user",
            );
            if (
              !message?.recordingId ||
              !lesson.recordings.some(
                (recording) => recording.id === message.recordingId,
              )
            )
              throw failure(400, "只能标记已保存录音的本人转写消息");
            const markedAt = stamp();
            for (const entry of lesson.conversation.messages)
              if (
                entry.id === message.id ||
                entry.id === `${message.id}-reply`
              ) {
                entry.excluded = true;
                entry.recognitionError = true;
                entry.recognitionErrorAt = markedAt;
              }
            const recording = lesson.recordings.find(
              (entry) => entry.id === message.recordingId,
            );
            recording.recognitionError = true;
            if (lesson.failedJob?.requestId === message.id) {
              lesson.failedJob = null;
              lesson.error = null;
            } else if (
              lesson.failedJob?.input &&
              ["conversation", "expression"].includes(lesson.failedJob.kind)
            ) {
              lesson.failedJob.input.history = conversationHistory(
                lesson.conversation.messages.filter(
                  (entry) => entry.id !== lesson.failedJob.requestId,
                ),
              );
            }
          } else if (action === "recording") {
            if (lesson.conversation.status === "finished")
              throw failure(409, "本次交流已结束，请先选择继续交流");
            if (lesson.pending)
              throw failure(409, "上一条反馈正在生成，请等待完成");
            if (lesson.recordings.length >= 100)
              throw failure(409, "本课程录音已达到上限");
            lesson._assets.push(body.asset);
            lesson.recordings.push({
              id: body.asset.id,
              contentType: body.asset.contentType,
              size: body.asset.size,
              durationSeconds: body.durationSeconds,
              status: "pending",
              audioUrl: `/api/daily/${id}/recordings/${body.asset.id}/audio`,
              createdAt: stamp(),
            });
            lesson.pending = {
              kind: "transcription",
              requestId,
              assetId: body.asset.id,
              state: "pending",
              runId: null,
              failures: 0,
            };
            lesson.error = null;
          } else if (action === "speech") {
            if (lesson.pending)
              throw failure(409, "上一条反馈正在生成，请等待完成");
            const message = lesson.conversation.messages.find(
              (entry) =>
                entry.id === body.messageId && entry.role === "assistant",
            );
            if (!message) throw failure(400, "请选择已保存的老师消息");
            if (!message.audioUrl)
              lesson.pending = {
                kind: "speech",
                requestId,
                messageId: message.id,
                state: "pending",
                runId: null,
                failures: 0,
              };
          } else if (action === "reading") {
            if (
              !object(body.answers) ||
              Object.keys(body.answers).length > 30 ||
              !Object.values(body.answers).every(
                (v) =>
                  safeText(v, 2000) ||
                  (Array.isArray(v) && v.every((s) => safeText(s, 2000))),
              )
            )
              throw failure(400, "阅读答案格式无效");
            const results = lesson.content.reading.questions.map((q) => {
              const userAnswer = body.answers[q.id] || "";
              return {
                id: q.id,
                userAnswer,
                correct:
                  typeof userAnswer === "string" &&
                  normalizeAnswer(userAnswer) === normalizeAnswer(q.answer),
                answer: q.answer,
                evidence: q.evidence,
                explanation: q.explanation,
              };
            });
            lesson.reading.attempts.push({
              id: requestId,
              answers: clone(body.answers),
              score: results.filter((v) => v.correct).length,
              total: results.length,
              results,
              createdAt: stamp(),
            });
            lesson.reading.draft = { answers: clone(body.answers) };
          } else if (
            ["conversation", "expression-help", "writing"].includes(action)
          ) {
            if (
              action !== "writing" &&
              lesson.conversation.status === "finished"
            )
              throw failure(409, "本次交流已结束，请先选择继续交流");
            if (lesson.pending)
              throw failure(409, "上一条反馈正在生成，请等待完成");
            if (!safeText(body.text, 12000) || !body.text.trim())
              throw failure(400, "请输入不超过 12000 字符的练习内容");
            const kind = action === "expression-help" ? "expression" : action;
            const input = {
              source: sourceForRuntime(lesson.source),
              lesson: lesson.content,
              target_band: lesson.targetBand,
              text: body.text,
              history:
                kind === "writing"
                  ? writingHistory(lesson.writing)
                  : conversationHistory(lesson.conversation.messages),
              received_help: !!lesson.expressionHelp?.english,
            };
            if (kind === "writing") {
              const level = body.level || "basic";
              if (!["basic", "extension", "challenge"].includes(level))
                throw failure(400, "写作任务级别无效");
              if (
                body.action &&
                !["attempt", "ask", "answer", "question"].includes(body.action)
              )
                throw failure(400, "写作操作无效");
              input.level = level;
              input.action = ["ask", "question"].includes(body.action)
                ? "question"
                : "answer";
              if (input.action === "question" && body.question) {
                if (!safeText(body.question, 3000))
                  throw failure(400, "写作提问无效");
                input.text = `Student draft:\n${body.text.slice(0, 8500)}\nStudent question:\n${body.question}`;
              }
              lesson.writing.submissions.push({
                id: requestId,
                text: body.text,
                level,
                action: body.action || "attempt",
                ...(body.question ? { question: body.question } : {}),
                status: "pending",
                feedback: null,
                createdAt: stamp(),
              });
              lesson.writing.draft = { text: body.text, level };
            } else if (kind === "conversation") {
              if (lesson.conversation.messages.length >= 200)
                throw failure(409, "本次课程交流已达到上限");
              lesson.conversation.messages.push({
                id: requestId,
                role: "user",
                text: body.text,
                createdAt: stamp(),
              });
              lesson.conversation.draft = { text: "" };
            }
            lesson.pending = {
              kind,
              requestId,
              state: "pending",
              runId: null,
              input,
              failures: 0,
              ...(body.action ? { action: body.action } : {}),
            };
            lesson.error = null;
          } else throw failure(404, "练习操作不存在");
        }
        lesson._requests[requestId] = fingerprint;
        return lesson;
      });
      return publicLesson(result, capabilities);
    },
    async upload(userId, id, req, url) {
      const body = {
        expectedVersion: Number(url.searchParams.get("expectedVersion")),
        requestId: url.searchParams.get("requestId"),
      };
      validateRequest(body);
      const durationSeconds = Number(url.searchParams.get("durationSeconds"));
      if (
        !url.searchParams.has("durationSeconds") ||
        !Number.isFinite(durationSeconds) ||
        durationSeconds < 0 ||
        durationSeconds > 7200
      )
        throw failure(400, "录音时长无效");
      const lesson = await storage.getDaily(userId, mode, id);
      if (!lesson) throw failure(404, "课程不存在");
      if (
        !lesson._requests[body.requestId] &&
        lesson.version !== body.expectedVersion
      )
        throw failure(409, "课程已更新，请刷新后重试", {
          currentVersion: lesson.version,
        });
      if (
        !lesson._requests[body.requestId] &&
        (lesson.status !== "ready" ||
          lesson.conversation.status === "finished" ||
          lesson.pending ||
          lesson.recordings.length >= 100)
      )
        throw failure(409, "课程尚未准备好或上一条反馈正在生成");
      if (Number(req.headers["content-length"]) > 32 * 1024 * 1024)
        throw failure(413, "录音超过 32 MiB 限制");
      const asset = await audio.save(
        userId,
        mode,
        id,
        body.requestId,
        "recording",
        req.headers["content-type"] || "",
        req.iterator({ destroyOnReturn: false }),
      );
      return service.action(userId, id, "recording", {
        ...body,
        durationSeconds,
        asset,
      });
    },
    async audio(userId, id, assetId) {
      const lesson = await storage.getDaily(userId, mode, id);
      if (!lesson) throw failure(404, "课程不存在");
      const asset = lesson._assets.find((value) => value.id === assetId);
      if (!asset) throw failure(404, "录音不存在");
      return audio.file(userId, mode, id, asset);
    },
    tick,
    close() {
      if (closePromise) return closePromise;
      closed = true;
      clearInterval(timer);
      closePromise = Promise.resolve()
        .then(() => runtime.close?.())
        .then(() => activeTick);
      return closePromise;
    },
    storage,
  };
  return service;
}
