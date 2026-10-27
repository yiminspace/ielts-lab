import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import { randomUUID } from "node:crypto";
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
const settle = () => new Promise((resolve) => setImmediate(resolve));
function fixture(
  onPut = async () => ({
    ok: true,
    status: 200,
    text: async () => '{"ok":true}',
  }),
) {
  const storage = new Map(),
    timers = new Map(),
    events = {},
    requests = [],
    warnings = [];
  let serial = 0;
  const context = vm.createContext({
    exports: {},
    require: () => ({
      useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    }),
    crypto: { randomUUID },
    TextEncoder,
    console: { warn: (...args) => warnings.push(args) },
    localStorage: {
      get length() {
        return storage.size;
      },
      key: (index) => [...storage.keys()][index] ?? null,
      removeItem: (key) => storage.delete(key),
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
    },
    addEventListener: (name, handler) => {
      events[name] = handler;
    },
    setTimeout: (handler) => {
      timers.set(++serial, handler);
      return serial;
    },
    clearTimeout: (id) => timers.delete(id),
    fetch: async (_url, options = {}) => {
      if (options.method === "PUT") {
        requests.push(options);
        return onPut(options);
      }
      return {
        ok: true,
        json: async () => ({
          attempts: [],
          bookmarks: [],
          drafts: {},
          notes: {},
        }),
      };
    },
  });
  vm.runInContext(code, context);
  return {
    api: context.exports,
    events,
    requests,
    warnings,
    async flush() {
      for (const [id, handler] of timers) {
        timers.delete(id);
        handler();
      }
      await settle();
    },
  };
}
test("repeated active-page checkpoints do not enter the browser keepalive request budget", async () => {
  const f = fixture(async (options) => {
    if (options.keepalive) throw new Error("Simulated keepalive quota");
    return { ok: true, status: 200, text: async () => "" };
  });
  await f.api.hydrateProgress("demo");
  for (let second = 1; second <= 80; second++) {
    f.api.saveDraft("paper:listening", { audioPosition: second });
    await f.flush();
  }
  assert.equal(f.requests.length, 80);
  assert.ok(f.requests.every((request) => request.keepalive === false));
  assert.equal(f.api.useSaveError(), "");
  assert.equal(f.warnings.length, 0);
});
test("only page exit uses keepalive and its budget measures UTF-8 bytes", async () => {
  const small = fixture();
  await small.api.hydrateProgress("demo");
  small.api.saveDraft("paper", { notes: "Short note" });
  small.events.pagehide();
  await settle();
  assert.equal(small.requests[0].keepalive, true);
  const large = fixture();
  await large.api.hydrateProgress("demo");
  large.api.saveDraft("paper", { notes: "汉".repeat(25000) });
  large.events.pagehide();
  await settle();
  assert.ok(large.requests[0].body.length < 60000);
  assert.ok(
    new TextEncoder().encode(large.requests[0].body).byteLength > 60000,
  );
  assert.equal(large.requests[0].keepalive, false);
});
test("the next save waits for the previous response body to complete", async () => {
  let release;
  const body = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const f = fixture(async () => ({
    ok: true,
    status: 200,
    text: () => (++calls === 1 ? body : Promise.resolve("")),
  }));
  await f.api.hydrateProgress("demo");
  f.api.saveDraft("paper", { audioPosition: 1 });
  await f.flush();
  f.api.saveDraft("paper", { audioPosition: 2 });
  await f.flush();
  assert.equal(f.requests.length, 1);
  release("");
  await settle();
  assert.equal(f.requests.length, 2);
});
test("a network failure retains the warning until a subsequent acknowledged save", async () => {
  let fail = true;
  const f = fixture(async () => {
    if (fail) throw new Error("Failed to fetch");
    return { ok: true, status: 200, text: async () => "" };
  });
  await f.api.hydrateProgress("demo");
  f.api.saveDraft("paper", { audioPosition: 1 });
  await f.flush();
  assert.match(f.api.useSaveError(), /暂未同步/);
  fail = false;
  f.api.saveDraft("paper", { audioPosition: 2 });
  await f.flush();
  assert.equal(f.api.useSaveError(), "");
});
