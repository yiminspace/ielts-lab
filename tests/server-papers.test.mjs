import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/index.mjs";
import { loadLibrary } from "../server/library.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ielts-paper-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = path.join(root, "archive");
  const organized = path.join(archive, "data/整理");
  const mediaRelative = `aa/${"a".repeat(64)}.wav`;
  const media = path.join(archive, "data/media", mediaRelative);
  await fs.mkdir(path.dirname(media), { recursive: true });
  await fs.copyFile(
    new URL("../server/assets/demo-listening.wav", import.meta.url),
    media,
  );
  const source = "https://example.invalid/original.wav";
  const paperId = "private-origin-paper-id";
  const refs = {};
  const documents = {};
  const responseFiles = {};
  const requestRows = [];
  let serial = 0;
  const write = async (file, value) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value));
  };
  await write(path.join(organized, "模考目录/general.json"), {
    title: "培训类",
    data: {
      paperList: [
        {
          topicName: "Fixture G",
          testPapers: [{ paperId, paperName: "Test 1" }],
        },
      ],
    },
  });
  for (const [kind, category, field, counts, endpoint] of [
    [
      "listening",
      "听力",
      "listeningId",
      [10, 10, 10, 10],
      "/hcp/qsBank/listening/examListeningV2",
    ],
    [
      "reading",
      "阅读",
      "passagesId",
      [13, 13, 14],
      "/hcp/qsBank/passages/examPassagesV2",
    ],
    [
      "writing",
      "写作",
      "writingId",
      [1, 1],
      "/hcp/qsBank/writings/examWritingsV2",
    ],
  ]) {
    refs[kind] = [];
    documents[kind] = [];
    for (const [index, count] of counts.entries()) {
      const data = {
        [field]: `${kind}-original-${index + 1}`,
        [kind === "writing" ? "writingPart" : "part"]: index + 1,
        userId: "private-user-marker",
        ...(kind === "writing"
          ? { writingQuestion: "Original writing prompt" }
          : {
              questions: [
                {
                  questionType: 0,
                  questionCount: count,
                  questionJson: {
                    questionType: "0",
                    startIndex: 1,
                    endIndex: count,
                    questionNum: count,
                    questionsContent: "Original question ......",
                  },
                  answerJson: Array.from({ length: count }, () => ({
                    correctValue: "sample",
                  })),
                },
              ],
              ...(kind === "listening"
                ? { audioUrl: source }
                : { passagesContent: "Original passage" }),
            }),
      };
      const file = path.join(organized, category, `part-${index + 1}.json`);
      const document = {
        title: `Fixture ${kind} ${index + 1}`,
        data,
        localMedia: { [source]: "../../media/" + mediaRelative },
      };
      await write(file, document);
      refs[kind].push(data);
      documents[kind].push({ file, document });
    }
    const relative = `data/raw/hcp/${String(++serial).padStart(64, "0")}.json`;
    const file = path.join(archive, relative);
    responseFiles[kind] = file;
    await write(file, { status: 0, content: refs[kind] });
    requestRows.push({
      path: endpoint,
      params: JSON.stringify({ testPaperId: paperId }),
      file: relative,
      detail: "private-provenance-marker",
    });
  }
  await write(path.join(archive, "data/目录/请求来源.json"), requestRows);
  return {
    root,
    archive,
    media,
    mediaRelative,
    paperId,
    refs,
    documents,
    responseFiles,
    requestRows,
    write,
  };
}

async function running(t, f, forceDemo = false) {
  const app = await createApp({
    projectRoot: f.root,
    archiveRoot: f.archive,
    forceDemo,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        app.server.closeAllConnections();
        app.server.close(resolve);
      }),
  );
  return { ...app, url: `http://127.0.0.1:${app.server.address().port}` };
}

test("paper APIs expose only stable hashed links and ordered complete G sections", async (t) => {
  const f = await fixture(t);
  for (const kind of ["listening", "reading", "writing"])
    await f.write(f.responseFiles[kind], {
      status: 0,
      content: [...f.refs[kind]].reverse(),
    });
  const app = await running(t, f);
  const response = await fetch(app.url + "/api/papers");
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.ok(!body.includes(f.paperId));
  assert.ok(!body.includes("testPaperId"));
  assert.ok(!body.includes("private-provenance-marker"));
  const paper = JSON.parse(body).papers.find(
    (paper) => paper.source === "archive",
  );
  assert.match(paper.id, /^paper-[a-f0-9]{20}$/);
  assert.equal(paper.ready, true);
  assert.equal(paper.listeningMarks, 40);
  assert.equal(paper.readingMarks, 40);
  assert.deepEqual(paper.issues, []);
  const detail = await (
    await fetch(app.url + "/api/papers/" + paper.id)
  ).json();
  for (const [kind, count] of [
    ["listening", 4],
    ["reading", 3],
    ["writing", 2],
  ]) {
    assert.equal(detail[kind].length, count);
    assert.deepEqual(
      detail[kind].map((item) => item.id),
      detail[`${kind}Ids`],
    );
    assert.deepEqual(
      detail[kind].map(
        (item) => item.data[kind === "writing" ? "writingPart" : "part"],
      ),
      Array.from({ length: count }, (_, i) => i + 1),
    );
  }
  assert.ok(!JSON.stringify(detail).includes("private-user-marker"));
  assert.ok(
    detail.listening.every((item) => item.data.audioUrl.startsWith("/media/")),
  );
  assert.equal((await fetch(app.url + "/api/papers/missing")).status, 404);
  assert.equal((await fetch(app.url + "/api/papers/bad%20id")).status, 400);
  const head = await fetch(app.url + "/api/papers/" + paper.id, {
    method: "HEAD",
  });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("removed or symlink-redirected audio makes an already loaded paper unavailable", async (t) => {
  const f = await fixture(t);
  const app = await running(t, f);
  const paper = app.library.papers.find((paper) => paper.source === "archive");
  assert.equal(paper.ready, true);
  await fs.unlink(f.media);
  let detail = await (await fetch(app.url + "/api/papers/" + paper.id)).json();
  assert.equal(detail.ready, false);
  assert.ok(detail.issues.some((issue) => issue.includes("本地音频")));
  const outside = path.join(f.root, "outside.wav");
  await fs.copyFile(
    new URL("../server/assets/demo-listening.wav", import.meta.url),
    outside,
  );
  await fs.symlink(outside, f.media);
  const list = await (await fetch(app.url + "/api/papers")).json();
  assert.equal(list.papers.find((item) => item.id === paper.id).ready, false);
  assert.equal(
    (await fetch(app.url + "/media/" + f.mediaRelative)).status,
    403,
  );
});

test("missing original links cannot be repaired by guessing matching titles or part numbers", async (t) => {
  const f = await fixture(t);
  const original = f.documents.reading[1];
  await fs.unlink(original.file);
  await f.write(path.join(path.dirname(original.file), "unrelated-book.json"), {
    ...original.document,
    data: {
      ...original.document.data,
      passagesId: "unrelated-material",
      testTrack: "general",
    },
  });
  const library = await loadLibrary({ archiveRoot: f.archive });
  const paper = library.papers.find((paper) => paper.source === "archive");
  assert.equal(paper.ready, false);
  assert.equal(paper.readingIds.length, 2);
  assert.ok(paper.issues.some((issue) => issue.includes("唯一对应")));
});

test("wrong marks, duplicate part numbers and conflicting provenance block full-paper readiness", async (t) => {
  for (const problem of ["marks", "parts", "links", "track"]) {
    const f = await fixture(t);
    if (problem === "marks") {
      const row = f.documents.reading[2];
      row.document.data.questions[0].answerJson.push({ correctValue: "extra" });
      row.document.data.questions[0].questionCount = 15;
      row.document.data.questions[0].questionJson.questionNum = 15;
      await f.write(row.file, row.document);
    } else if (problem === "parts") {
      f.refs.listening[3].part = 3;
      await f.write(f.responseFiles.listening, {
        status: 0,
        content: f.refs.listening,
      });
    } else if (problem === "track") {
      const row = f.documents.writing[0];
      row.document.data.testTrack = "academic";
      await f.write(row.file, row.document);
    } else {
      const file = `data/raw/hcp/${"f".repeat(64)}.json`;
      await f.write(path.join(f.archive, file), {
        status: 0,
        content: f.refs.reading.slice(0, 2),
      });
      await f.write(path.join(f.archive, "data/目录/请求来源.json"), [
        ...f.requestRows,
        { ...f.requestRows[1], file },
      ]);
    }
    const library = await loadLibrary({ archiveRoot: f.archive });
    const paper = library.papers.find((paper) => paper.source === "archive");
    assert.equal(paper.ready, false, problem);
    assert.ok(paper.issues.length > 0, problem);
  }
});

test("original short paper is available in both modes and never masquerades as forty-question sections", async (t) => {
  const f = await fixture(t);
  for (const forceDemo of [false, true]) {
    const app = await running(t, f, forceDemo);
    const detail = await (
      await fetch(app.url + "/api/papers/original-general-flow-demo")
    ).json();
    assert.equal(detail.shortDemo, true);
    assert.equal(detail.source, "original");
    assert.equal(detail.ready, true);
    assert.equal(detail.listeningMarks, 16);
    assert.equal(detail.readingMarks, 18);
    assert.equal(new Set(detail.listeningIds).size, 4);
    assert.deepEqual(
      detail.writing.map((item) => item.data.writingPart),
      [1, 2],
    );
    assert.ok(
      detail.issues.some((issue) => issue.includes("不是完整40题试卷")),
    );
    assert.ok(detail.issues.some((issue) => issue.includes("重复")));
    for (const id of detail.listeningIds)
      assert.equal((await fetch(app.url + "/api/items/" + id)).status, 200);
    const audio = await fetch(app.url + detail.listening[0].data.audioUrl, {
      headers: { Range: "bytes=0-11" },
    });
    assert.equal(audio.status, 206);
    assert.deepEqual(
      Buffer.from(await audio.arrayBuffer()),
      (
        await fs.readFile(
          new URL("../server/assets/demo-listening.wav", import.meta.url),
        )
      ).subarray(0, 12),
    );
  }
});
