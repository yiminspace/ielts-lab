import { useSyncExternalStore } from "react";
import type { Attempt, Progress } from "../types";

type Bucket = "drafts" | "notes" | "bookmarks" | "settings";
type Revisions = Record<Bucket, Record<string, number>>;
type Operation = {
  bucket: Bucket | "attempts";
  id: string;
  value: unknown;
  expectedVersion: number;
  clientId: string;
  blocked?: boolean;
  blockedVersion?: number;
  ancestors?: string[];
  writer?: string;
  createdAt?: number;
  acknowledgedVersion?: number;
};
const empty = (): Progress => ({
  attempts: [],
  bookmarks: [],
  drafts: {},
  notes: {},
  settings: {},
});
const emptyRevisions = (): Revisions => ({
  drafts: {},
  notes: {},
  bookmarks: {},
  settings: {},
});
let KEY = "ielts-lab-progress-v1";
let identity = "";
let mode = "archive";
let state = empty();
let revisions = emptyRevisions();
let outbox: Record<string, Operation> = {};
let journal: Record<string, Operation> = {};
let journalFingerprint = "";
const writerId = crypto.randomUUID();
const volatileOperations: Record<string, Operation> = {};
let hosted = false;
let cacheEnabled = false;
let epoch = 0;
let mutationGeneration = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout>;
let pendingSave: Promise<unknown> = Promise.resolve();
let saveError = "";
let hydrated = false;
let dirty = false;
const pendingAttemptIds = new Set<string>();
function newAttemptKey(id: string) {
  return `${KEY}::new-attempt::${id}`;
}
function pendingNewAttempts(attempts: Attempt[]) {
  return attempts
    .filter((attempt) => {
      try {
        return (
          pendingAttemptIds.has(attempt.id) ||
          localStorage.getItem(newAttemptKey(attempt.id)) === "pending"
        );
      } catch {
        return pendingAttemptIds.has(attempt.id);
      }
    })
    .map((attempt) => attempt.id);
}

function valid(value: unknown): value is Progress {
  const p = value as Progress;
  return (
    !!p &&
    typeof p === "object" &&
    Array.isArray(p.attempts) &&
    p.attempts.length <= 10000 &&
    p.attempts.every(
      (a) =>
        a &&
        typeof a.id === "string" &&
        typeof a.itemId === "string" &&
        typeof a.title === "string" &&
        typeof a.kind === "string" &&
        typeof a.createdAt === "string" &&
        Number.isFinite(Date.parse(a.createdAt)) &&
        (a.score === undefined || Number.isFinite(a.score)) &&
        (a.total === undefined || Number.isFinite(a.total)),
    ) &&
    Array.isArray(p.bookmarks) &&
    p.bookmarks.every((x) => typeof x === "string") &&
    !!p.drafts &&
    typeof p.drafts === "object" &&
    !Array.isArray(p.drafts) &&
    !!p.notes &&
    typeof p.notes === "object" &&
    !Array.isArray(p.notes) &&
    Object.values(p.notes).every((x) => typeof x === "string") &&
    (p.settings === undefined ||
      (!!p.settings &&
        typeof p.settings === "object" &&
        !Array.isArray(p.settings)))
  );
}
function progressOnly(p: Progress): Progress {
  return {
    attempts: p.attempts,
    bookmarks: p.bookmarks,
    drafts: p.drafts,
    notes: p.notes,
    settings: p.settings || {},
    ...(p.updatedAt ? { updatedAt: p.updatedAt } : {}),
  };
}
function notify() {
  listeners.forEach((fn) => fn());
}
function cacheBrowser() {
  if (!cacheEnabled) return;
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        ...state,
        ...(hosted ? { __sync: { journalVersion: 1, revisions, outbox } } : {}),
      }),
    );
  } catch {
    saveError = "浏览器存储空间不足，请及时导出学习记录。";
  }
}
function readCache() {
  const p = JSON.parse(localStorage.getItem(KEY) || "null");
  if (!valid(p)) return null;
  return p as Progress & {
    __sync?: {
      journalVersion?: number;
      revisions?: Revisions;
      outbox?: Record<string, Operation>;
    };
  };
}
function operationKey(bucket: string, id: string) {
  return JSON.stringify([bucket, id]);
}
function journalKey(clientId: string) {
  return `${KEY}::op::${clientId}`;
}
function writeOperation(op: Operation) {
  journal[op.clientId] = op;
  try {
    localStorage.setItem(journalKey(op.clientId), JSON.stringify(op));
    delete volatileOperations[op.clientId];
    return true;
  } catch {
    volatileOperations[op.clientId] = op;
    saveError = "浏览器存储空间不足，请及时导出学习记录。";
    return false;
  }
}
function removeOperation(clientId: string) {
  try {
    localStorage.removeItem(journalKey(clientId));
  } catch {
    return;
  }
  delete journal[clientId];
  delete volatileOperations[clientId];
}
function readJournal() {
  if (!hosted || !cacheEnabled) return;
  const found: Record<string, Operation> = {};
  const prefix = `${KEY}::op::`;
  // Each operation owns a separate storage entry. Updating a snapshot never erases
  // another tab's newly persisted work, even if its storage event has not arrived.
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(prefix)) continue;
    try {
      const op = JSON.parse(localStorage.getItem(key) || "null") as Operation;
      if (
        op &&
        typeof op.clientId === "string" &&
        key === journalKey(op.clientId) &&
        ["drafts", "notes", "bookmarks", "settings", "attempts"].includes(
          op.bucket,
        ) &&
        typeof op.id === "string" &&
        Number.isSafeInteger(op.expectedVersion) &&
        (!op.ancestors ||
          (Array.isArray(op.ancestors) &&
            op.ancestors.every((id) => typeof id === "string")))
      )
        found[op.clientId] = op;
    } catch {
      /* A broken journal entry never replaces valid work. */
    }
  }
  Object.assign(found, volatileOperations);
  const fingerprint = JSON.stringify(
    Object.keys(found)
      .sort()
      .map((id) => [
        id,
        found[id].acknowledgedVersion,
        found[id].blocked,
        found[id].blockedVersion,
        found[id].expectedVersion,
      ]),
  );
  if (fingerprint !== journalFingerprint) mutationGeneration++;
  journalFingerprint = fingerprint;
  journal = found;
  const superseded = new Set(
    Object.values(found)
      .filter((op) => !op.acknowledgedVersion)
      .flatMap((op) => op.ancestors || []),
  );
  outbox = {};
  for (const op of Object.values(found)) {
    if (op.acknowledgedVersion || superseded.has(op.clientId)) continue;
    let expectedVersion = op.expectedVersion;
    for (const id of op.ancestors || [])
      expectedVersion = Math.max(
        expectedVersion,
        found[id]?.acknowledgedVersion || 0,
      );
    const effective = {
      ...op,
      expectedVersion,
      ...(op.blocked &&
      expectedVersion > (op.blockedVersion ?? op.expectedVersion)
        ? { blocked: false }
        : {}),
    };
    const key = operationKey(op.bucket, op.id),
      previous = outbox[key];
    // A tab retains its own independent branch; every branch remains in the
    // durable journal and is included when exporting pending edits.
    if (
      !previous ||
      (effective.writer === writerId && previous.writer !== writerId) ||
      ((previous.writer === writerId) === (effective.writer === writerId) &&
        ((effective.createdAt || 0) > (previous.createdAt || 0) ||
          (effective.createdAt === previous.createdAt &&
            effective.clientId > previous.clientId)))
    )
      outbox[key] = effective;
  }
  dirty = Object.values(found).some(
    (op) => !op.acknowledgedVersion && !superseded.has(op.clientId),
  );
  if (
    saveError.includes("另一设备") &&
    !pendingLeaves().some((op) => op.blocked)
  )
    saveError = "";
}
function pendingLeaves() {
  const superseded = new Set(
    Object.values(journal)
      .filter((op) => !op.acknowledgedVersion)
      .flatMap((op) => op.ancestors || []),
  );
  return Object.values(journal)
    .filter((op) => !op.acknowledgedVersion && !superseded.has(op.clientId))
    .map((op) => {
      let expectedVersion = op.expectedVersion;
      for (const id of op.ancestors || [])
        expectedVersion = Math.max(
          expectedVersion,
          journal[id]?.acknowledgedVersion || 0,
        );
      return {
        ...op,
        expectedVersion,
        ...(op.blocked &&
        expectedVersion > (op.blockedVersion ?? op.expectedVersion)
          ? { blocked: false }
          : {}),
      };
    })
    .sort(
      (a, b) =>
        (a.createdAt || 0) - (b.createdAt || 0) ||
        a.clientId.localeCompare(b.clientId),
    );
}
function refreshBrowser() {
  if (!cacheEnabled) return;
  try {
    let next = state;
    const p = readCache();
    const browserTime = Date.parse(p?.updatedAt || "") || 0;
    const stateTime = Date.parse(state.updatedAt || "") || 0;
    if (
      p &&
      (browserTime > stateTime || (hosted && browserTime === stateTime))
    ) {
      if (browserTime > stateTime) mutationGeneration++;
      next = progressOnly(p);
      if (hosted) revisions = p.__sync?.revisions || revisions;
      else dirty = false;
    }
    if (hosted) next = overlay(next);
    // Render-time readers also reconcile pending browser work. Keep the external
    // store snapshot stable when that reconciliation changes no values; replacing
    // it on every read makes React retry any review that reads its saved draft.
    if (JSON.stringify(next) !== JSON.stringify(state)) state = next;
  } catch {
    /* keep last valid state */
  }
}
addEventListener("storage", (e) => {
  if (
    e.key === KEY ||
    (typeof e.key === "string" && e.key.startsWith(`${KEY}::op::`))
  ) {
    refreshBrowser();
    notify();
    if (hosted && hydrated && dirty) saveServer();
  }
});
function queue(bucket: Bucket | "attempts", id: string, value: unknown) {
  const key = operationKey(bucket, id),
    previous = outbox[key];
  const op: Operation = {
    bucket,
    id,
    value,
    expectedVersion:
      previous?.expectedVersion ??
      (bucket === "attempts" ? 0 : revisions[bucket]?.[id] || 0),
    clientId: crypto.randomUUID(),
    writer: writerId,
    createdAt: Date.parse(state.updatedAt || "") || Date.now(),
    ancestors: previous
      ? [...(previous.ancestors || []), previous.clientId]
      : [],
    ...(previous?.blocked
      ? {
          blocked: true,
          blockedVersion: previous.blockedVersion ?? previous.expectedVersion,
        }
      : {}),
  };
  if (writeOperation(op)) {
    // The new durable leaf already contains the full edit and ancestry IDs.
    // Remove superseded unsent payloads so a long offline essay does not retain
    // a full draft copy per keystroke. A late response can still acknowledge its
    // captured ancestor ID and advance this leaf's CAS baseline.
    for (const id of op.ancestors || [])
      if (!journal[id]?.acknowledgedVersion) removeOperation(id);
  }
  outbox[key] = op;
}

function diff(previous: Progress, next: Progress) {
  for (const bucket of ["drafts", "notes", "settings"] as const) {
    const before = previous[bucket] || {},
      after = next[bucket] || {};
    for (const id of new Set([...Object.keys(before), ...Object.keys(after)]))
      if (JSON.stringify(before[id]) !== JSON.stringify(after[id]))
        queue(bucket, id, after[id] ?? null);
  }
  for (const id of new Set([...previous.bookmarks, ...next.bookmarks]))
    if (previous.bookmarks.includes(id) !== next.bookmarks.includes(id))
      queue("bookmarks", id, next.bookmarks.includes(id));
  const existing = new Set(previous.attempts.map((a) => a.id));
  for (const attempt of next.attempts)
    if (!existing.has(attempt.id)) queue("attempts", attempt.id, attempt);
}
function applyOperation(next: Progress, op: Operation) {
  if (op.bucket === "attempts") {
    if (!next.attempts.some((a) => a.id === op.id))
      next.attempts.unshift(op.value as Attempt);
  } else if (op.bucket === "bookmarks") {
    next.bookmarks = next.bookmarks.filter((id) => id !== op.id);
    if (op.value) next.bookmarks.push(op.id);
  } else {
    const map = next[op.bucket] as Record<string, unknown>;
    if (op.value === null) delete map[op.id];
    else map[op.id] = op.value;
  }
}
function overlay(server: Progress): Progress {
  readJournal();
  const next = progressOnly(server);
  next.drafts = { ...next.drafts };
  next.notes = { ...next.notes };
  next.settings = { ...next.settings };
  next.bookmarks = [...next.bookmarks];
  next.attempts = [...next.attempts];
  for (const op of Object.values(journal)
    .filter((op) => op.acknowledgedVersion)
    .sort((a, b) => a.acknowledgedVersion! - b.acknowledgedVersion!)) {
    if (op.bucket === "attempts") applyOperation(next, op);
    else if (op.acknowledgedVersion! >= (revisions[op.bucket]?.[op.id] || 0)) {
      revisions[op.bucket][op.id] = op.acknowledgedVersion!;
      applyOperation(next, op);
    }
  }
  for (const op of Object.values(outbox)) applyOperation(next, op);
  return next;
}
async function flushEntities(leavingPage: boolean, capturedEpoch: number) {
  refreshBrowser();
  const work = pendingLeaves();
  for (const original of work) {
    if (capturedEpoch !== epoch || !hosted || !hydrated) return;
    refreshBrowser();
    const op = pendingLeaves().find(
      (entry) => entry.clientId === original.clientId,
    );
    if (!op || op.blocked) continue;
    const body = JSON.stringify(
      op.bucket === "attempts"
        ? op.value
        : { value: op.value, expectedVersion: op.expectedVersion },
    );
    const r = await fetch(
      op.bucket === "attempts"
        ? "/api/attempts"
        : `/api/progress/${op.bucket}/${encodeURIComponent(op.id)}`,
      {
        method: op.bucket === "attempts" ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive:
          leavingPage && new TextEncoder().encode(body).byteLength < 60000,
      },
    );
    const text = await r.text();
    if (capturedEpoch !== epoch) return;
    refreshBrowser();
    const current = journal[op.clientId];
    if (r.status === 409) {
      // A duplicate request can lose the CAS race after another tab has already
      // acknowledged this exact operation. Never attach its conflict to a newer edit.
      if (current && !current.acknowledgedVersion)
        writeOperation({
          ...current,
          blocked: true,
          blockedVersion: op.expectedVersion,
        });
      state = overlay(state);
      if (pendingLeaves().some((entry) => entry.blocked))
        saveError =
          "另一设备已更新同一记录，本机输入已保留。请先导出备份，再载入服务器记录。";
      cacheBrowser();
      notify();
      continue;
    }
    if (!r.ok) throw new Error(`保存失败 (${r.status})`);
    const result = text ? JSON.parse(text) : {};
    const version = op.bucket === "attempts" ? 1 : result.version;
    if (!Number.isSafeInteger(version) || version < 1)
      throw new Error("服务器未确认记录版本");
    writeOperation({ ...op, acknowledgedVersion: version, blocked: false });
    // The acknowledged leaf contains the complete value, so old local keystroke
    // checkpoints can be removed. Independent branches are never removed here.
    for (const id of op.ancestors || []) removeOperation(id);
    for (const entry of Object.values(journal))
      if (
        entry.clientId !== op.clientId &&
        entry.bucket === op.bucket &&
        entry.id === op.id &&
        entry.acknowledgedVersion &&
        entry.acknowledgedVersion <= version
      )
        removeOperation(entry.clientId);
    mutationGeneration++;
    state = overlay(state);
    if (!pendingLeaves().some((entry) => entry.blocked)) saveError = "";
    cacheBrowser();
    notify();
  }
}
async function saveEntities(leavingPage: boolean, capturedEpoch: number) {
  if (typeof navigator !== "undefined" && navigator.locks?.request)
    await navigator.locks.request(`${KEY}::flush`, () =>
      flushEntities(leavingPage, capturedEpoch),
    );
  else await flushEntities(leavingPage, capturedEpoch);
}

function saveServer(leavingPage = false) {
  if (!hydrated || !dirty) return;
  const body = JSON.stringify(state),
    version = state.updatedAt,
    capturedEpoch = epoch,
    newAttempts = !hosted ? pendingNewAttempts(state.attempts) : [];
  pendingSave = pendingSave
    .catch(() => {})
    .then(async () => {
      if (capturedEpoch !== epoch) return;
      try {
        if (hosted) {
          await saveEntities(leavingPage, capturedEpoch);
          return;
        }
        const r = await fetch("/api/progress", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            ...(newAttempts.length
              ? { "X-IELTS-New-Attempts": newAttempts.join(",") }
              : {}),
          },
          body,
          keepalive:
            leavingPage && new TextEncoder().encode(body).byteLength < 60000,
        });
        await r.text?.();
        if (capturedEpoch !== epoch) return;
        if (r.status === 409) {
          saveError =
            "另一窗口已有更新，当前输入仍在浏览器中。请导出备份后刷新，以免覆盖新记录。";
          notify();
          return;
        }
        if (!r.ok) throw new Error("保存到本地服务失败");
        for (const id of newAttempts) {
          pendingAttemptIds.delete(id);
          try {
            localStorage.removeItem(newAttemptKey(id));
          } catch {
            /* A retry is idempotent. */
          }
        }
        saveError = "";
        if (state.updatedAt === version) dirty = false;
      } catch {
        if (capturedEpoch !== epoch) return;
        saveError =
          "学习记录已留在浏览器，服务暂未同步；连接恢复后会重新保存。";
      }
      notify();
    });
}
function persist(next: Progress) {
  mutationGeneration++;
  const previous = state;
  state = {
    ...next,
    updatedAt: new Date(
      Math.max(Date.now(), (Date.parse(state.updatedAt || "") || 0) + 1),
    ).toISOString(),
  };
  if (hosted) diff(previous, state);
  dirty = true;
  cacheBrowser();
  notify();
  clearTimeout(timer);
  timer = setTimeout(saveServer, 300);
}
addEventListener("pagehide", () => {
  clearTimeout(timer);
  saveServer(true);
});
addEventListener("online", () => saveServer());
addEventListener("focus", () => {
  if (hosted && hydrated) void refreshServerProgress();
});

export function configureProgressIdentity(userId: string) {
  if (identity === userId) return;
  resetProgress();
  identity = userId;
}
export function resetProgress() {
  epoch++;
  clearTimeout(timer);
  hydrated = false;
  dirty = false;
  hosted = false;
  cacheEnabled = false;
  state = empty();
  revisions = emptyRevisions();
  outbox = {};
  journal = {};
  journalFingerprint = "";
  for (const key of Object.keys(volatileOperations))
    delete volatileOperations[key];
  pendingSave = Promise.resolve();
  saveError = "";
  identity = "";
  pendingAttemptIds.clear();
  notify();
}
export function useProgress() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
  );
}
export function useSaveError() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => saveError,
  );
}
export function getProgress() {
  refreshBrowser();
  const pending = hosted ? pendingLeaves() : [];
  return pending.length
    ? {
        ...state,
        pendingEdits: pending.map(
          ({ bucket, id, value, expectedVersion, clientId, blocked }) => ({
            bucket,
            id,
            value,
            expectedVersion,
            clientId,
            blocked,
          }),
        ),
      }
    : state;
}
export function recordAttempt(a: Omit<Attempt, "id" | "createdAt">) {
  refreshBrowser();
  const attempt = {
    ...a,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  if (!hosted) {
    pendingAttemptIds.add(attempt.id);
    try {
      localStorage.setItem(newAttemptKey(attempt.id), "pending");
    } catch {
      /* Keep the in-memory marker while this page remains open. */
    }
  }
  persist({
    ...state,
    attempts: [attempt, ...state.attempts].slice(0, hosted ? 10000 : 2000),
  });
}
export function saveDraft(id: string, value: any) {
  refreshBrowser();
  persist({ ...state, drafts: { ...state.drafts, [id]: value } });
}
export function saveDraftIfCurrent(id: string, value: any, expected: string) {
  refreshBrowser();
  if (JSON.stringify(state.drafts[id] ?? null) !== expected) return false;
  persist({ ...state, drafts: { ...state.drafts, [id]: value } });
  return true;
}
export function saveNote(id: string, value: string) {
  refreshBrowser();
  persist({ ...state, notes: { ...state.notes, [id]: value } });
}
export function saveSetting(id: string, value: unknown) {
  refreshBrowser();
  persist({ ...state, settings: { ...state.settings, [id]: value } });
}
export function toggleBookmark(id: string) {
  refreshBrowser();
  persist({
    ...state,
    bookmarks: state.bookmarks.includes(id)
      ? state.bookmarks.filter((x) => x !== id)
      : [...state.bookmarks, id],
  });
}
async function fetchServerProgress() {
  const r = await fetch("/api/progress", { cache: "no-store" });
  if (!r.ok) throw new Error("学习记录加载失败");
  const p = await r.json();
  if (!valid(p)) throw new Error("学习记录格式不正确");
  const remote = p as Progress & {
    sync?: { protocol: string; userId: string; revisions: Revisions };
  };
  if (identity && remote.sync?.userId !== identity)
    throw new Error("学习记录身份不匹配");
  return {
    ...remote,
    sync: remote.sync || {
      protocol: "legacy",
      userId: "",
      revisions: emptyRevisions(),
    },
  };
}
export async function hydrateProgress(nextMode = "archive") {
  const capturedEpoch = epoch;
  mode = nextMode;
  KEY = identity
    ? `ielts-lab-progress-v2-${identity}-${mode}`
    : `ielts-lab-progress-v1-${mode}`;
  cacheEnabled = true;
  hosted = !!identity;
  state = empty();
  revisions = emptyRevisions();
  outbox = {};
  journal = {};
  journalFingerprint = "";
  dirty = false;
  if (hosted) readJournal();
  try {
    const cached = readCache();
    if (cached) {
      state = progressOnly(cached);
      if (hosted && cached.__sync) {
        revisions = cached.__sync.revisions || emptyRevisions();
        readJournal();
        if (cached.__sync.journalVersion !== 1) {
          for (const op of Object.values(cached.__sync.outbox || {})) {
            const represented =
              journal[op.clientId] ||
              Object.values(journal).some((entry) =>
                entry.ancestors?.includes(op.clientId),
              );
            if (!represented)
              writeOperation({
                ...op,
                createdAt: Date.parse(cached.updatedAt || "") || 0,
                writer: "legacy",
              });
          }
        }
        readJournal();
      }
    }
  } catch {
    /* no saved browser progress */
  }
  try {
    const p = await fetchServerProgress();
    if (capturedEpoch !== epoch) return;
    if (identity) {
      if (p.sync?.protocol !== "entities-v1")
        throw new Error("服务器未提供分项同步");
      hosted = true;
      revisions = p.sync.revisions;
      state = overlay(p);
      cacheBrowser();
      if (Object.values(outbox).some((op) => op.blocked))
        saveError =
          "另一设备已更新同一记录，本机输入已保留。请先导出备份，再载入服务器记录。";
    } else if (
      (Date.parse(p.updatedAt || "") || 0) >=
      (Date.parse(state.updatedAt || "") || 0)
    ) {
      state = progressOnly(p);
      cacheBrowser();
    } else if (state.updatedAt) dirty = true;
  } catch (error) {
    if (capturedEpoch !== epoch) return;
    if (identity) {
      resetProgress();
      throw error;
    }
    saveError = "暂未连接到本地记录服务，当前使用浏览器中的学习记录。";
  }
  hydrated = true;
  if (!hosted && pendingNewAttempts(state.attempts).length) dirty = true;
  if (dirty) saveServer();
  notify();
}
export async function refreshServerProgress() {
  if (!hosted || !hydrated) return;
  const capturedEpoch = epoch;
  try {
    await pendingSave;
    const generation = mutationGeneration;
    const p = await fetchServerProgress();
    if (capturedEpoch !== epoch) return;
    refreshBrowser();
    if (generation !== mutationGeneration) return;
    revisions = p.sync.revisions;
    state = overlay(p);
    cacheBrowser();
    notify();
    if (dirty) saveServer();
  } catch {
    /* retain local draft until the next confirmed synchronization */
  }
}
// The caller must first offer an export; this explicitly discards the pending local edits.
export async function reloadServerProgress() {
  const capturedEpoch = epoch;
  await pendingSave;
  const generation = mutationGeneration;
  const p = await fetchServerProgress();
  if (capturedEpoch !== epoch) return;
  refreshBrowser();
  if (generation !== mutationGeneration)
    throw new Error("加载期间有新的输入，请先备份后重试。");
  if (hosted) {
    readJournal();
    for (const op of Object.values(journal)) removeOperation(op.clientId);
  }
  outbox = {};
  dirty = false;
  revisions = p.sync?.revisions || emptyRevisions();
  state = progressOnly(p);
  saveError = "";
  cacheBrowser();
  notify();
}
export function importProgress(value: unknown): void | Promise<void> {
  if (!valid(value)) throw new Error("不是有效的学习记录文件");
  if (!hosted) {
    persist({ ...empty(), ...value });
    return;
  }
  const capturedEpoch = epoch;
  return (async () => {
    await pendingSave;
    if (capturedEpoch !== epoch || !hosted || !hydrated) return;
    refreshBrowser();
    if (pendingLeaves().length)
      throw new Error("请先同步或备份未保存的修改，再导入记录。");
    const r = await fetch("/api/progress/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ progress: progressOnly(value), merge: true }),
    });
    if (!r.ok) throw new Error("导入失败，现有记录已保留。");
    if (capturedEpoch === epoch) await refreshServerProgress();
  })();
}
