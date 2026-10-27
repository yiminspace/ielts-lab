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
const tick = () => new Promise((resolve) => setImmediate(resolve));
function environment() {
  const data = {
    attempts: [],
    bookmarks: [],
    drafts: {},
    notes: {},
    settings: {},
    updatedAt: new Date().toISOString(),
  };
  const revisions = { drafts: {}, notes: {}, bookmarks: {}, settings: {} };
  const writes = [];
  const writeGates = [];
  function writeResponse(status, payload) {
    const at = writeGates.findIndex((gate) => gate.status === status);
    const gate = at >= 0 ? writeGates.splice(at, 1)[0] : null;
    gate?.started();
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => {
        if (gate) await gate.wait;
        return JSON.stringify(payload);
      },
    };
  }
  let offline = false,
    responseOwner = "owner",
    nextSnapshotGate = null,
    nextImportGate = null;
  function device(storage = new Map()) {
    const timers = new Map(),
      events = {};
    let serial = 0;
    const context = vm.createContext({
      exports: {},
      require: () => ({ useSyncExternalStore: (_fn, snapshot) => snapshot() }),
      crypto: { randomUUID },
      TextEncoder,
      console,
      localStorage: {
        get length() {
          return storage.size;
        },
        key: (index) => [...storage.keys()][index] ?? null,
        removeItem: (key) => storage.delete(key),
        getItem: (key) => storage.get(key) || null,
        setItem: (key, value) => storage.set(key, value),
      },
      addEventListener: (name, fn) => {
        events[name] = fn;
      },
      setTimeout: (fn) => {
        timers.set(++serial, fn);
        return serial;
      },
      clearTimeout: (id) => timers.delete(id),
      fetch: async (url, options = {}) => {
        if (offline) throw new Error("Offline");
        if (url === "/api/progress") {
          const snapshot = structuredClone({
            ...data,
            sync: { protocol: "entities-v1", userId: responseOwner, revisions },
          });
          if (nextSnapshotGate) {
            const gate = nextSnapshotGate;
            nextSnapshotGate = null;
            gate.started();
            await gate.wait;
          }
          return { ok: true, status: 200, json: async () => snapshot };
        }
        const parsed = JSON.parse(options.body);
        if (url === "/api/progress/import") {
          const p = parsed.progress;
          for (const bucket of ["drafts", "notes", "settings"])
            for (const [id, value] of Object.entries(p[bucket] || {}))
              if (!(id in data[bucket])) {
                data[bucket][id] = structuredClone(value);
                revisions[bucket][id] = 1;
              }
          for (const a of p.attempts || [])
            if (!data.attempts.some((old) => old.id === a.id))
              data.attempts.push(a);
          if (nextImportGate) {
            const gate = nextImportGate;
            nextImportGate = null;
            gate.started();
            await gate.wait;
          }
          return { ok: true, status: 200, text: async () => '{"ok":true}' };
        }
        const [, bucket, encoded] =
          /^\/api\/progress\/([^/]+)\/(.+)$/.exec(url) || [];
        if (bucket) {
          const id = decodeURIComponent(encoded),
            old = revisions[bucket][id] || 0;
          if (parsed.expectedVersion !== old)
            return writeResponse(409, { error: "Conflict" });
          revisions[bucket][id] = old + 1;
          if (bucket === "bookmarks") {
            data.bookmarks = data.bookmarks.filter((x) => x !== id);
            if (parsed.value) data.bookmarks.push(id);
          } else if (parsed.value === null) delete data[bucket][id];
          else data[bucket][id] = structuredClone(parsed.value);
          data.updatedAt = new Date().toISOString();
          writes.push({ bucket, id, value: parsed.value });
          return writeResponse(200, {
            version: old + 1,
            updatedAt: data.updatedAt,
          });
        }
        if (url === "/api/attempts") {
          if (!data.attempts.some((a) => a.id === parsed.id))
            data.attempts.unshift(parsed);
          writes.push({ bucket: "attempts" });
          return { ok: true, status: 201, text: async () => "{}" };
        }
        throw new Error("Unexpected " + url);
      },
    });
    vm.runInContext(code, context);
    return {
      api: context.exports,
      storage,
      events,
      async flush() {
        for (const [id, fn] of timers) {
          timers.delete(id);
          fn();
        }
        await tick();
        await tick();
      },
    };
  }
  return {
    data,
    revisions,
    writes,
    device,
    setOffline: (value) => {
      offline = value;
    },
    setOwner: (value) => {
      responseOwner = value;
    },
    holdNextWrite(status = 200) {
      let release, started;
      const wait = new Promise((resolve) => {
        release = resolve;
      });
      const entered = new Promise((resolve) => {
        started = resolve;
      });
      writeGates.push({ status, wait, started });
      return { release, started: entered };
    },
    holdNextSnapshot() {
      let release, started;
      const wait = new Promise((resolve) => {
        release = resolve;
      });
      const entered = new Promise((resolve) => {
        started = resolve;
      });
      nextSnapshotGate = { wait, started };
      return { release, started: entered };
    },
    holdNextImport() {
      let release, started;
      const wait = new Promise((resolve) => {
        release = resolve;
      });
      const entered = new Promise((resolve) => {
        started = resolve;
      });
      nextImportGate = { wait, started };
      return { release, started: entered };
    },
  };
}
test("independent devices update different entities without replacing unseen work", async () => {
  const env = environment(),
    a = env.device(),
    b = env.device();
  a.api.configureProgressIdentity("owner");
  b.api.configureProgressIdentity("owner");
  await a.api.hydrateProgress("archive");
  await b.api.hydrateProgress("archive");
  a.api.saveDraft("essay", { text: "A preserved essay" });
  await a.flush();
  b.api.saveNote("reading", "Independent note");
  await b.flush();
  assert.equal(env.data.drafts.essay.text, "A preserved essay");
  assert.equal(env.data.notes.reading, "Independent note");
  assert.deepEqual(
    env.writes.map((w) => w.bucket),
    ["drafts", "notes"],
  );
  await a.api.refreshServerProgress();
  assert.equal(a.api.getProgress().notes.reading, "Independent note");
});
test("same-draft conflicts keep local input and do not overwrite the newer server version", async () => {
  const env = environment(),
    a = env.device(),
    b = env.device();
  for (const d of [a, b]) {
    d.api.configureProgressIdentity("owner");
    await d.api.hydrateProgress();
  }
  a.api.saveDraft("essay", { text: "Server winner" });
  await a.flush();
  b.api.saveDraft("essay", { text: "Local unsaved copy" });
  await b.flush();
  assert.equal(env.data.drafts.essay.text, "Server winner");
  assert.equal(b.api.getProgress().drafts.essay.text, "Local unsaved copy");
  assert.match(b.api.useSaveError(), /另一设备/);
  await b.api.reloadServerProgress();
  assert.equal(b.api.getProgress().drafts.essay.text, "Server winner");
  assert.equal(b.api.useSaveError(), "");
});
test("a pending offline draft survives reload and is retried using its original revision", async () => {
  const env = environment(),
    a = env.device();
  a.api.configureProgressIdentity("owner");
  await a.api.hydrateProgress();
  env.setOffline(true);
  a.api.saveDraft("essay", { text: "Offline work" });
  await a.flush();
  assert.match(a.api.useSaveError(), /暂未同步/);
  env.setOffline(false);
  const reloaded = env.device(a.storage);
  reloaded.api.configureProgressIdentity("owner");
  await reloaded.api.hydrateProgress();
  await reloaded.flush();
  assert.equal(env.data.drafts.essay.text, "Offline work");
  assert.equal(reloaded.api.useSaveError(), "");
});
test("a session with a different verified identity never hydrates another user cache", async () => {
  const env = environment(),
    a = env.device();
  a.api.configureProgressIdentity("owner");
  await a.api.hydrateProgress();
  a.api.saveDraft("essay", { text: "Private" });
  await a.flush();
  a.api.resetProgress();
  a.api.configureProgressIdentity("different-user");
  await assert.rejects(() => a.api.hydrateProgress(), /身份不匹配/);
  assert.equal(a.api.getProgress().drafts.essay, undefined);
});
test("receiving a server snapshot does not re-upload it as local changes", async () => {
  const env = environment();
  env.data.drafts.essay = { text: "Already saved" };
  env.revisions.drafts.essay = 3;
  const a = env.device();
  a.api.configureProgressIdentity("owner");
  await a.api.hydrateProgress();
  await a.flush();
  assert.equal(env.writes.length, 0);
  a.api.saveDraft("essay", { text: "Next version" });
  await a.flush();
  assert.equal(env.revisions.drafts.essay, 4);
});

test("logout does not reload the previous owner cache before a new session hydrates", async () => {
  const env = environment(),
    a = env.device();
  a.api.configureProgressIdentity("owner");
  await a.api.hydrateProgress();
  a.api.saveDraft("essay", { text: "Private cached essay" });
  await a.flush();
  a.api.resetProgress();
  assert.equal(a.api.getProgress().drafts.essay, undefined);
  a.events.storage?.({ key: "ielts-lab-progress-v2-owner-archive" });
  assert.equal(a.api.getProgress().drafts.essay, undefined);
});
test("a delayed server snapshot cannot roll back an edit already acknowledged while the read was in flight", async () => {
  const env = environment(),
    a = env.device();
  a.api.configureProgressIdentity("owner");
  await a.api.hydrateProgress();
  const gate = env.holdNextSnapshot();
  const refresh = a.api.refreshServerProgress();
  await gate.started;
  a.api.saveDraft("essay", { text: "Acknowledged during refresh" });
  await a.flush();
  assert.equal(env.data.drafts.essay.text, "Acknowledged during refresh");
  gate.release();
  await refresh;
  assert.equal(
    a.api.getProgress().drafts.essay?.text,
    "Acknowledged during refresh",
  );
});

test("additive backup import preserves edits typed while the import request is pending", async () => {
  const env = environment(),
    a = env.device();
  a.api.configureProgressIdentity("owner");
  await a.api.hydrateProgress();
  const gate = env.holdNextImport();
  const importing = a.api.importProgress({
    attempts: [],
    bookmarks: [],
    drafts: { backup: { text: "Old backup" } },
    notes: {},
    settings: {},
  });
  await gate.started;
  a.api.saveDraft("fresh", { text: "Typed while importing" });
  gate.release();
  await importing;
  assert.equal(a.api.getProgress().drafts.fresh?.text, "Typed while importing");
  await a.flush();
  assert.equal(env.data.drafts.fresh?.text, "Typed while importing");
});

test("shared-origin tabs cannot erase each other outbox between localStorage read and write", async () => {
  const env = environment(),
    storage = new Map();
  env.data.updatedAt = new Date(Date.now() + 10000).toISOString();
  const a = env.device(storage),
    b = env.device(storage);
  for (const d of [a, b]) {
    d.api.configureProgressIdentity("owner");
    await d.api.hydrateProgress();
  }
  const originalSet = storage.set.bind(storage);
  let interleave = true;
  storage.set = (key, value) => {
    // Tab B writes after A has read the cache but before A's older snapshot commits.
    if (interleave) {
      interleave = false;
      b.api.saveNote("reading", "B note must survive");
    }
    return originalSet(key, value);
  };
  a.api.saveDraft("essay", { text: "A essay must survive" });
  await b.flush();
  await a.flush();
  assert.equal(env.data.drafts.essay?.text, "A essay must survive");
  assert.equal(env.data.notes.reading, "B note must survive");
});

test("independent durable outbox entries survive closing both tabs before any network flush", async () => {
  const env = environment(),
    storage = new Map(),
    a = env.device(storage),
    b = env.device(storage);
  for (const d of [a, b]) {
    d.api.configureProgressIdentity("owner");
    await d.api.hydrateProgress();
  }
  const originalSet = storage.set.bind(storage);
  let interleave = true;
  storage.set = (key, value) => {
    if (interleave) {
      interleave = false;
      b.api.saveNote("reading", "Durable B note");
    }
    return originalSet(key, value);
  };
  env.setOffline(true);
  a.api.saveDraft("essay", { text: "Durable A essay" });
  a.api.resetProgress();
  b.api.resetProgress();
  env.setOffline(false);
  const recovered = env.device(storage);
  recovered.api.configureProgressIdentity("owner");
  await recovered.api.hydrateProgress();
  await recovered.flush();
  assert.equal(env.data.drafts.essay?.text, "Durable A essay");
  assert.equal(env.data.notes.reading, "Durable B note");
});
test("a delayed duplicate 409 cannot block a newer edit after another tab acknowledged its parent", async () => {
  const env = environment(),
    storage = new Map(),
    a = env.device(storage),
    b = env.device(storage);
  for (const d of [a, b]) {
    d.api.configureProgressIdentity("owner");
    await d.api.hydrateProgress();
  }
  const first = env.holdNextWrite(200);
  a.api.saveDraft("essay", { text: "First version" });
  await a.flush();
  await first.started;
  b.api.getProgress();
  const duplicate = env.holdNextWrite(409);
  b.events.online();
  await b.flush();
  await duplicate.started;
  first.release();
  await tick();
  await tick();
  b.api.saveDraft("essay", { text: "Newer version" });
  duplicate.release();
  await b.flush();
  await tick();
  assert.equal(env.data.drafts.essay?.text, "Newer version");
  assert.equal(b.api.useSaveError(), "");
  assert.equal(b.api.getProgress().pendingEdits, undefined);
});

test("a long offline edit keeps one durable leaf rather than one full essay per keystroke", async () => {
  const env = environment(),
    a = env.device();
  a.api.configureProgressIdentity("owner");
  await a.api.hydrateProgress();
  env.setOffline(true);
  for (let i = 1; i <= 300; i++)
    a.api.saveDraft("essay", { text: "Original offline text ".repeat(i) });
  const entries = [...a.storage.keys()].filter((key) => key.includes("::op::"));
  assert.equal(entries.length, 1);
  a.api.resetProgress();
  env.setOffline(false);
  const restored = env.device(a.storage);
  restored.api.configureProgressIdentity("owner");
  await restored.api.hydrateProgress();
  await restored.flush();
  assert.equal(
    env.data.drafts.essay.text,
    "Original offline text ".repeat(300),
  );
});
