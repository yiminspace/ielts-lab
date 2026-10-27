import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import ts from "typescript";

const code = ts.transpileModule(
  await readFile(
    new URL("../apps/web/src/lib/progress.ts", import.meta.url),
    "utf8",
  ),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
function environment() {
  const storage = new Map();
  const service = {
    value: { attempts: [], bookmarks: [], drafts: {}, notes: {} },
    writes: [],
  };
  function tab() {
    const events = {};
    const timers = new Map();
    let serial = 0;
    const context = vm.createContext({
      exports: {},
      require: () => ({
        useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
      }),
      crypto: { randomUUID },
      localStorage: {
        get length() {
          return storage.size;
        },
        key: (index) => [...storage.keys()][index] ?? null,
        removeItem: (key) => storage.delete(key),
        getItem: (k) => storage.get(k) ?? null,
        setItem: (k, v) => storage.set(k, v),
      },
      addEventListener: (name, fn) => {
        events[name] = fn;
      },
      setTimeout: (fn) => {
        timers.set(++serial, fn);
        return serial;
      },
      clearTimeout: (id) => timers.delete(id),
      fetch: async (_url, options = {}) => {
        if (options.method === "PUT") {
          service.value = JSON.parse(options.body);
          service.writes.push(service.value);
          return { ok: true, status: 200 };
        }
        return { ok: true, json: async () => structuredClone(service.value) };
      },
    });
    vm.runInContext(code, context);
    return {
      api: context.exports,
      events,
      async flush() {
        for (const [id, fn] of timers) {
          timers.delete(id);
          fn();
        }
        await new Promise((resolve) => setImmediate(resolve));
      },
    };
  }
  return { tab, service, storage };
}
test("closing an uninitialized tab never writes empty progress over stored work", async () => {
  const env = environment();
  env.service.value.drafts.essay = { text: "A saved essay" };
  const t = env.tab();
  t.events.pagehide();
  await t.flush();
  assert.equal(env.service.writes.length, 0);
  assert.equal(env.service.value.drafts.essay.text, "A saved essay");
});
test("a stale second tab preserves a first tab draft when adding a bookmark", async () => {
  const env = environment();
  const a = env.tab(),
    b = env.tab();
  await a.api.hydrateProgress("demo");
  await b.api.hydrateProgress("demo");
  a.api.saveDraft("essay", { text: "Keep this essay" });
  await a.flush();
  b.api.toggleBookmark("reading-1");
  await b.flush();
  assert.equal(env.service.value.drafts.essay.text, "Keep this essay");
  assert.deepEqual(env.service.value.bookmarks, ["reading-1"]);
});
test("demo and archive browser progress stay isolated", async () => {
  const env = environment();
  const a = env.tab();
  await a.api.hydrateProgress("demo");
  a.api.saveDraft("demo", { text: "Test" });
  await a.flush();
  env.service.value = { attempts: [], bookmarks: [], drafts: {}, notes: {} };
  const b = env.tab();
  await b.api.hydrateProgress("archive");
  assert.equal(b.api.getProgress().drafts.demo, undefined);
});
test("a stale same-exam draft cannot overwrite newer answers before storage events arrive", async () => {
  const env = environment();
  const a = env.tab(),
    b = env.tab();
  await a.api.hydrateProgress("demo");
  await b.api.hydrateProgress("demo");
  const key = "exam:reading-1";
  assert.equal(
    a.api.saveDraftIfCurrent(
      key,
      { answers: { q1: "new answer" }, revision: 1 },
      "null",
    ),
    true,
  );
  assert.equal(
    b.api.saveDraftIfCurrent(key, { answers: {}, revision: 1 }, "null"),
    false,
  );
  assert.equal(b.api.getProgress().drafts[key].answers.q1, "new answer");
  await b.flush();
  await a.flush();
  assert.equal(env.service.value.drafts[key].answers.q1, "new answer");
  const current = JSON.stringify(a.api.getProgress().drafts[key]);
  assert.equal(
    a.api.saveDraftIfCurrent(
      key,
      { answers: { q1: "next answer" }, revision: 2 },
      current,
    ),
    true,
  );
});
test("invalid imported notes cannot crash the workspace", () => {
  const t = environment().tab();
  assert.throws(
    () =>
      t.api.importProgress({
        attempts: [],
        bookmarks: [],
        drafts: {},
        notes: null,
      }),
    /有效/,
  );
});
