import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { createApp, parseRange, validProgress } from "../server/index.mjs";
import { loadLibrary, validateArchive } from "../server/library.mjs";
import { generalTrainingItems } from "../server/general-training.mjs";
import { importSummary } from "../server/import.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ielts-lab-test-"));
  const archive = path.join(root, "archive");
  const organized = path.join(archive, "data/整理");
  const mediaRoot = path.join(archive, "data/media");
  await fs.mkdir(mediaRoot, { recursive: true });
  await fs.mkdir(organized, { recursive: true });
  const mediaRelative = `aa/${"a".repeat(64)}.mp3`;
  await fs.mkdir(path.dirname(path.join(mediaRoot, mediaRelative)), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(mediaRoot, mediaRelative),
    Buffer.from("0123456789"),
  );
  const source = "https://example.invalid/audio.mp3";
  const doc = async (category, name, data, extra = {}) => {
    const dir = path.join(organized, category);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, name + ".json"),
      JSON.stringify({
        title: name,
        category,
        data,
        localMedia: { [source]: "../../media/" + mediaRelative },
        ...extra,
      }),
    );
  };
  await doc("听力", "A local lesson", {
    audioUrl: source,
    questionCount: 1,
    questions: [{ questionCount: 1 }],
    html: `<p><img src="${source}"><img src="https://example.invalid/missing.png"></p>`,
    user: { phone: "private" },
    updateName: "private",
    nested: { token: "secret", useful: true },
  });
  await doc("我的学习", "Private account", { token: "private" });
  await doc("词库", "Words", { items: [{ headWord: "curiosity" }] });
  await doc("发音链接", "Audio", {
    items: [
      {
        manifestType: "word",
        targetId: "curiosity",
        accent: "bf_emma",
        audioUrl: source,
      },
    ],
  });
  await doc("打字练习", "Typing", [
    { title: "Original one", content: "One" },
    { title: "Original two", content: "Two" },
  ]);
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(root, "dist/index.html"),
    "<h1>Original test app</h1>",
  );
  await fs.writeFile(
    path.join(root, "config.local.json"),
    JSON.stringify({ archiveRoot: archive }),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, archive, organized, mediaRoot, mediaRelative, doc };
}
async function running(t, options) {
  const app = await createApp(options);
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        app.server.closeAllConnections();
        app.server.close(resolve);
      }),
  );
  const url = `http://127.0.0.1:${app.server.address().port}`;
  return { ...app, url };
}

async function trackFixture(t) {
  const fixtureData = await fixture(t);
  const { archive, doc } = fixtureData;
  const files = [];
  const requestRows = [];
  async function response(kind, paperId, rows) {
    const file = `data/raw/hcp/${String(files.length + 1).padStart(64, "0")}.json`;
    files.push(file);
    await fs.mkdir(path.dirname(path.join(archive, file)), { recursive: true });
    await fs.writeFile(
      path.join(archive, file),
      JSON.stringify({ status: 0, content: rows }),
    );
    requestRows.push({
      path: `/hcp/qsBank/${kind === "reading" ? "passages/examPassagesV2" : "writings/examWritingsV2"}`,
      params: JSON.stringify({ testPaperId: paperId }),
      file,
      detail: "private provenance marker must not enter API",
    });
  }
  await doc("模考目录", "学术类", {
    paperList: [{ testPapers: [{ paperId: "paper-a" }] }],
  });
  await doc("模考目录", "培训类", {
    paperList: [{ testPapers: [{ paperId: "paper-g" }] }],
  });
  await doc("阅读", "Cambridge reading A", {
    passagesId: "reading-a",
    examType: 0,
    questions: [],
  });
  await doc("阅读", "Cambridge reading G", {
    passagesId: "reading-g",
    examType: 1,
    questions: [],
  });
  await doc("阅读", "Cambridge reading missing", {
    passagesId: "reading-missing",
    examType: 1,
    questions: [],
  });
  await doc("阅读", "Cambridge reading conflicting", {
    passagesId: "reading-conflicting",
    questions: [],
  });
  await doc("阅读", "Academic Reading explicit conflict", {
    passagesId: "reading-explicit",
    testTrack: "general",
    questions: [],
  });
  await doc("写作", "Cambridge writing A", {
    writingId: "writing-a",
    writingPart: 1,
  });
  await doc("写作", "Cambridge writing G", {
    writingId: "writing-g",
    writingPart: 2,
  });
  await response("reading", "paper-a", [
    { passagesId: "reading-a" },
    { passagesId: "reading-conflicting" },
  ]);
  await response("reading", "paper-g", [
    { passagesId: "reading-g" },
    { passagesId: "reading-conflicting" },
    { passagesId: "reading-explicit" },
  ]);
  await response("writing", "paper-a", [{ writingId: "writing-a" }]);
  await response("writing", "paper-g", [{ writingId: "writing-g" }]);
  const requestFile = path.join(archive, "data/目录/请求来源.json");
  await fs.mkdir(path.dirname(requestFile), { recursive: true });
  await fs.writeFile(requestFile, JSON.stringify(requestRows));
  return { ...fixtureData, files, requestRows, requestFile };
}
function rawRequest(url, route, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      { host: parsed.hostname, port: parsed.port, path: route, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}
const progress = {
  updatedAt: "2026-10-18T01:00:01Z",
  attempts: [
    {
      id: "attempt-1",
      itemId: "demo-listening",
      title: "Demo",
      kind: "listening",
      createdAt: "2026-10-18T01:00:00Z",
      score: 3,
      total: 4,
      answers: { 1: "Monday" },
    },
  ],
  bookmarks: ["demo-listening"],
  drafts: { note: { text: "A local draft" } },
  notes: { lesson: "A local note" },
};

test("demo is original, includes every supported kind, and can be forced over configuration", async (t) => {
  const fixtureData = await fixture(t);
  const library = await loadLibrary({
    forceDemo: true,
    archiveRoot: fixtureData.archive,
  });
  assert.equal(library.mode, "demo");
  assert.equal(
    library.publicLibrary.items.length,
    10 + generalTrainingItems.length,
  );
  assert.equal(
    new Set(library.publicLibrary.items.map((item) => item.kind)).size,
    10,
  );
  assert.equal(
    (await library.getItem("demo-listening")).data.audioUrl,
    "/media/demo-listening.wav",
  );
  assert.equal(await library.getItem("missing"), null);
});

test("archive indexing allowlists study categories and rewrites local media without exposing identity metadata", async (t) => {
  const { archive } = await fixture(t);
  const library = await loadLibrary({ archiveRoot: archive });
  assert.equal(
    library.publicLibrary.items.filter((item) => item.source === "archive")
      .length,
    4,
  );
  assert.equal(library.publicLibrary.counts.typing, 2);
  assert.ok(
    !library.publicLibrary.items.some(
      (item) => item.title === "Private account",
    ),
  );
  const ref = library.publicLibrary.items.find(
    (item) => item.kind === "listening",
  );
  const item = await library.getItem(ref.id);
  assert.match(item.data.audioUrl, /^\/media\/aa\//);
  assert.ok(item.data.html.includes("/media/aa/"));
  assert.ok(!item.data.html.includes("example.invalid"));
  assert.equal(item.data.user, undefined);
  assert.equal(item.data.updateName, undefined);
  assert.equal(item.data.nested.token, undefined);
  assert.equal(item.data.nested.useful, true);
  const words = await library.getItem(
    library.publicLibrary.items.find((item) => item.kind === "vocabulary").id,
  );
  assert.match(words.data.items[0].audioUrls.bf_emma, /^\/media\//);
});

test("import totals exclude bundled original lessons and empty archives still fail before configuration is written", async (t) => {
  const f = await fixture(t);
  let library = await loadLibrary({ archiveRoot: f.archive });
  const summary = importSummary(library);
  assert.equal(summary.count, 4);
  assert.equal(summary.counts.typing, 2);
  assert.equal(summary.originalItems, generalTrainingItems.length);
  assert.equal(summary.counts.reading, undefined);
  const previousConfig = await fs.readFile(
    path.join(f.root, "config.local.json"),
    "utf8",
  );
  await fs.rm(f.organized, { recursive: true });
  await fs.mkdir(f.organized);
  library = await loadLibrary({ archiveRoot: f.archive });
  assert.equal(library.publicLibrary.items.length, generalTrainingItems.length);
  assert.throws(() => importSummary(library), /没有可导入的学习材料/);
  assert.equal(
    await fs.readFile(path.join(f.root, "config.local.json"), "utf8"),
    previousConfig,
  );
});

test("original G lessons remain reachable through the API in archive and demo modes", async (t) => {
  const { root } = await fixture(t);
  for (const forceDemo of [false, true]) {
    const app = await running(t, { projectRoot: root, forceDemo });
    const library = await (await fetch(app.url + "/api/library")).json();
    for (const original of generalTrainingItems) {
      const listed = library.items.find((item) => item.id === original.id);
      assert.equal(listed.source, "original");
      assert.equal(listed.testTrack, "general");
      const response = await fetch(app.url + "/api/items/" + original.id);
      assert.equal(response.status, 200);
      const item = await response.json();
      assert.equal(item.testTrack, "general");
      assert.deepEqual(item.data, original.data);
      assert.deepEqual(item.localMedia, {});
    }
  }
});

test("archive tracks follow explicitly named catalogs and response IDs; missing or contradictory evidence stays unknown", async (t) => {
  const { archive } = await trackFixture(t);
  const library = await loadLibrary({ archiveRoot: archive });
  const byTitle = new Map(
    library.publicLibrary.items.map((item) => [item.title, item]),
  );
  for (const [title, expected] of [
    ["Cambridge reading A", "academic"],
    ["Cambridge reading G", "general"],
    ["Cambridge writing A", "academic"],
    ["Cambridge writing G", "general"],
    ["Cambridge reading missing", "unclassified"],
    ["Cambridge reading conflicting", "unclassified"],
    ["Academic Reading explicit conflict", "unclassified"],
  ]) {
    const item = byTitle.get(title);
    assert.equal(item.testTrack, expected, title);
    assert.equal((await library.getItem(item.id)).testTrack, expected, title);
    assert.equal(item.source, "archive");
  }
  assert.equal(
    library.allowedMedia.size,
    1,
    "catalog covers and provenance are not extra media",
  );
  assert.equal(
    byTitle.has("学术类"),
    false,
    "classification catalogs are not study items",
  );
  assert.ok(
    !JSON.stringify(library.publicLibrary).includes(
      "private provenance marker",
    ),
  );
  assert.ok(!JSON.stringify(library.publicLibrary).includes("testPaperId"));
});

test("unavailable catalogs cannot turn numeric producer enums into guessed A/G tracks", async (t) => {
  const { archive, organized } = await trackFixture(t);
  await fs.rm(path.join(organized, "模考目录"), { recursive: true });
  const library = await loadLibrary({ archiveRoot: archive });
  for (const item of library.publicLibrary.items.filter(
    (item) =>
      item.source === "archive" && ["reading", "writing"].includes(item.kind),
  ))
    assert.equal(item.testTrack, "unclassified", item.title);
});

test("classification provenance rejects traversal and symlinks outside its specific directory", async (t) => {
  const f = await trackFixture(t);
  const outside = path.join(f.root, "outside-provenance.json");
  await fs.writeFile(
    outside,
    JSON.stringify({ status: 0, content: [{ passagesId: "reading-g" }] }),
  );
  const request = f.requestRows[1];
  await fs.writeFile(
    f.requestFile,
    JSON.stringify([{ ...request, file: "../outside-provenance.json" }]),
  );
  let library = await loadLibrary({ archiveRoot: f.archive });
  assert.equal(
    library.publicLibrary.items.find(
      (item) => item.title === "Cambridge reading G",
    ).testTrack,
    "unclassified",
  );
  await fs.writeFile(f.requestFile, JSON.stringify([request]));
  await fs.unlink(path.join(f.archive, request.file));
  await fs.symlink(outside, path.join(f.archive, request.file));
  library = await loadLibrary({ archiveRoot: f.archive });
  assert.equal(
    library.publicLibrary.items.find(
      (item) => item.title === "Cambridge reading G",
    ).testTrack,
    "unclassified",
  );
  const outsideIndex = path.join(f.root, "outside-index.json");
  await fs.writeFile(outsideIndex, JSON.stringify(f.requestRows));
  await fs.unlink(f.requestFile);
  await fs.symlink(outsideIndex, f.requestFile);
  library = await loadLibrary({ archiveRoot: f.archive });
  assert.equal(
    library.publicLibrary.items.find(
      (item) => item.title === "Cambridge writing A",
    ).testTrack,
    "unclassified",
  );
});

test("range parsing rejects malformed, multiple, empty and unsafe numeric ranges", () => {
  assert.deepEqual(parseRange("bytes=2-5", 10), { start: 2, end: 5 });
  assert.deepEqual(parseRange("bytes=8-", 10), { start: 8, end: 9 });
  assert.deepEqual(parseRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange("bytes=0-999", 10), { start: 0, end: 9 });
  for (const header of [
    "items=0-1",
    "bytes=",
    "bytes=-",
    "bytes=-0",
    "bytes=10-",
    "bytes=5-2",
    "bytes=1-2,4-5",
    "bytes=9007199254740992-",
    "bytes= 0-2",
  ])
    assert.equal(parseRange(header, 10), false, header);
  assert.equal(parseRange("bytes=0-", 0), false);
  assert.equal(parseRange(undefined, 10), null);
});

test("media supports byte ranges, suffix ranges, HEAD and 416 for seeking", async (t) => {
  const f = await fixture(t);
  const app = await running(t, { projectRoot: f.root });
  const media = app.url + "/media/" + f.mediaRelative;
  const partial = await fetch(media, { headers: { Range: "bytes=2-5" } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(await partial.text(), "2345");
  const suffix = await fetch(media, { headers: { Range: "bytes=-2" } });
  assert.equal(await suffix.text(), "89");
  const head = await fetch(media, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "10");
  assert.equal(await head.text(), "");
  const invalid = await fetch(media, { headers: { Range: "bytes=11-" } });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get("content-range"), "bytes */10");
});

test("traversal, symlink escape, unknown files and arbitrary remote proxy requests fail", async (t) => {
  const f = await fixture(t);
  const app = await running(t, { projectRoot: f.root });
  for (const route of [
    "/media/../config.local.json",
    "/media/%2e%2e/config.local.json",
    "/media/%2e%2e%5cconfig.local.json",
    "/%00",
    "/.local/progress-archive.json",
  ]) {
    const result = await rawRequest(app.url, route);
    assert.ok([403, 404].includes(result.status), route);
  }
  assert.equal(
    (await fetch(app.url + "/media/http://example.invalid/audio.mp3")).status,
    404,
  );
  assert.equal(
    (await fetch(app.url + "/media/aa/" + "b".repeat(64) + ".mp3")).status,
    404,
  );
  const outside = path.join(f.root, "outside.txt");
  await fs.writeFile(outside, "secret");
  await fs.unlink(path.join(f.mediaRoot, f.mediaRelative));
  await fs.symlink(outside, path.join(f.mediaRoot, f.mediaRelative));
  assert.equal(
    (await fetch(app.url + "/media/" + f.mediaRelative)).status,
    403,
  );
});

test("origin and Host checks reject cross-site writes and DNS rebinding", async (t) => {
  const f = await fixture(t);
  const app = await running(t, { projectRoot: f.root });
  const denied = await fetch(app.url + "/api/progress", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://attacker.invalid",
    },
    body: JSON.stringify(progress),
  });
  assert.equal(denied.status, 403);
  assert.equal(
    (await rawRequest(app.url, "/api/library", { Host: "attacker.invalid" }))
      .status,
    403,
  );
  const value = await (await fetch(app.url + "/api/progress")).json();
  assert.equal(value.attempts.length, 0);
});

test("progress validation, atomic persistence, and mode separation", async (t) => {
  const f = await fixture(t);
  const app = await running(t, { projectRoot: f.root });
  const put = async (body) =>
    fetch(app.url + "/api/progress", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: app.url },
      body: JSON.stringify(body),
    });
  assert.equal((await put(progress)).status, 200);
  assert.deepEqual(
    await (await fetch(app.url + "/api/progress")).json(),
    progress,
  );
  assert.deepEqual(
    JSON.parse(await fs.readFile(app.progressFile, "utf8")),
    progress,
  );
  const stale = {
    ...progress,
    updatedAt: "2026-10-18T00:00:01Z",
    notes: { lesson: "stale" },
  };
  assert.equal((await put(stale)).status, 409);
  const withoutTime = { ...progress };
  delete withoutTime.updatedAt;
  assert.equal((await put(withoutTime)).status, 409);
  const newer = {
    ...progress,
    updatedAt: "2026-10-18T01:00:02Z",
    notes: { lesson: "newer" },
  };
  const responses = await Promise.all([put(newer), put(stale)]);
  assert.equal(responses[0].status, 200);
  assert.equal(responses[1].status, 409);
  assert.deepEqual(
    await (await fetch(app.url + "/api/progress")).json(),
    newer,
  );
  assert.equal((await put({ ...progress, attempts: "invalid" })).status, 400);
  assert.equal(
    (await put({ ...progress, notes: { x: "a".repeat(5 * 1024 * 1024) } }))
      .status,
    413,
  );
  assert.equal((await fs.stat(app.progressFile)).mode & 0o777, 0o600);
  const demo = await running(t, { projectRoot: f.root, forceDemo: true });
  assert.deepEqual(await (await fetch(demo.url + "/api/progress")).json(), {
    attempts: [],
    bookmarks: [],
    drafts: {},
    notes: {},
  });
  assert.ok(demo.progressFile.endsWith("progress-demo.json"));
});

test("progress schema rejects prototype keys and invalid attempts", () => {
  assert.equal(validProgress(progress), true);
  assert.equal(validProgress({ ...progress, updatedAt: "invalid" }), false);
  assert.equal(
    validProgress(
      JSON.parse(
        '{"attempts":[],"bookmarks":[],"drafts":{"__proto__":{}},"notes":{}}',
      ),
    ),
    false,
  );
  assert.equal(
    validProgress({
      ...progress,
      attempts: [{ ...progress.attempts[0], createdAt: "not-a-date" }],
    }),
    false,
  );
  assert.equal(
    validProgress({
      ...progress,
      attempts: [{ ...progress.attempts[0], score: -1 }],
    }),
    false,
  );
  assert.equal(validProgress({ ...progress, notes: { x: 2 } }), false);
});

test("production serves only dist and demo assets; forced demo does not load archive material", async (t) => {
  const f = await fixture(t);
  const app = await running(t, { projectRoot: f.root, forceDemo: true });
  assert.match(await (await fetch(app.url + "/")).text(), /Original test app/);
  assert.equal((await fetch(app.url + "/config.local.json")).status, 404);
  assert.equal(
    (await fetch(app.url + "/media/" + f.mediaRelative)).status,
    404,
  );
  const asset = await fetch(app.url + "/media/demo-listening.wav");
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("content-type"), "audio/wav");
  assert.equal((await fetch(app.url + "/api/items/unknown")).status, 404);
  assert.equal(
    (await fetch(app.url + "/api/library", { method: "POST" })).status,
    405,
  );
});

test("an archive cannot redirect its media directory outside the chosen root", async (t) => {
  const f = await fixture(t);
  await fs.rm(f.mediaRoot, { recursive: true });
  await fs.symlink(f.root, f.mediaRoot);
  await assert.rejects(() => validateArchive(f.archive));
});
