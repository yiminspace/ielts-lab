import { useSyncExternalStore } from "react";
import type { Attempt, Progress } from "../types";
let KEY = "ielts-lab-progress-v1";
const empty: Progress = { attempts: [], bookmarks: [], drafts: {}, notes: {} };
let state: Progress = { ...empty };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout>;
let pendingSave: Promise<unknown> = Promise.resolve();
let saveError = "";
let hydrated = false;
let dirty = false;
function valid(value: unknown): value is Progress {
  const p = value as Progress;
  return (
    !!p &&
    typeof p === "object" &&
    Array.isArray(p.attempts) &&
    p.attempts.length <= 2000 &&
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
    Object.values(p.notes).every((x) => typeof x === "string")
  );
}
function notify() {
  listeners.forEach((fn) => fn());
}
function refreshBrowser() {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || "null");
    if (
      valid(p) &&
      (Date.parse(p.updatedAt || "") || 0) >
        (Date.parse(state.updatedAt || "") || 0)
    ) {
      state = p;
      dirty = false;
    }
  } catch {
    /* keep last valid state */
  }
}
addEventListener("storage", (e) => {
  if (e.key === KEY) {
    refreshBrowser();
    notify();
  }
});
function saveServer(leavingPage = false) {
  if (!hydrated || !dirty) return;
  const body = JSON.stringify(state);
  const version = state.updatedAt;
  pendingSave = pendingSave
    .catch(() => {})
    .then(async () => {
      try {
        const r = await fetch("/api/progress", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive:
            leavingPage && new TextEncoder().encode(body).byteLength < 60000,
        });
        // Complete the response before allowing the next queued request.
        await r.text?.();
        if (!r.ok)
          console.warn(
            "[progress save] HTTP",
            r.status,
            "revision",
            version,
            "bytes",
            new TextEncoder().encode(body).byteLength,
          );
        if (r.status === 409) {
          saveError =
            "另一窗口已有更新，当前输入仍在浏览器中。请导出备份后刷新，以免覆盖新记录。";
          notify();
          return;
        }
        if (!r.ok) throw new Error("保存到本地服务失败");
        saveError = "";
        if (state.updatedAt === version) dirty = false;
      } catch (error) {
        console.warn(
          "[progress save] request failed",
          error instanceof Error ? error.message : String(error),
          "revision",
          version,
          "bytes",
          new TextEncoder().encode(body).byteLength,
        );
        saveError =
          "学习记录已留在浏览器，本地服务暂未同步；恢复服务后继续操作会重新保存。";
      }
      notify();
    });
}
function persist(next: Progress) {
  state = {
    ...next,
    updatedAt: new Date(
      Math.max(Date.now(), (Date.parse(state.updatedAt || "") || 0) + 1),
    ).toISOString(),
  };
  dirty = true;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    saveError = "浏览器存储空间不足，请及时导出学习记录。";
  }
  notify();
  clearTimeout(timer);
  timer = setTimeout(saveServer, 300);
}
addEventListener("pagehide", () => {
  clearTimeout(timer);
  saveServer(true);
});
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
  return state;
}
export function recordAttempt(a: Omit<Attempt, "id" | "createdAt">) {
  refreshBrowser();
  persist({
    ...state,
    attempts: [
      { ...a, id: crypto.randomUUID(), createdAt: new Date().toISOString() },
      ...state.attempts,
    ].slice(0, 2000),
  });
}
export function saveDraft(id: string, value: any) {
  refreshBrowser();
  persist({ ...state, drafts: { ...state.drafts, [id]: value } });
}
// Call inside a per-draft Web Lock when available. The comparison also protects
// sequential writes before the browser delivers another tab's storage event.
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
export function toggleBookmark(id: string) {
  refreshBrowser();
  persist({
    ...state,
    bookmarks: state.bookmarks.includes(id)
      ? state.bookmarks.filter((x) => x !== id)
      : [...state.bookmarks, id],
  });
}
export async function hydrateProgress(mode: string = "archive") {
  KEY = "ielts-lab-progress-v1-" + mode;
  try {
    const local = JSON.parse(localStorage.getItem(KEY) || "null");
    if (valid(local)) state = { ...empty, ...local };
  } catch {
    /* no saved browser progress */
  }
  try {
    const r = await fetch("/api/progress");
    if (!r.ok) throw new Error("load");
    const p = await r.json();
    if (
      valid(p) &&
      (Date.parse(p.updatedAt || "") || 0) >=
        (Date.parse(state.updatedAt || "") || 0)
    ) {
      state = { ...empty, ...p };
      localStorage.setItem(KEY, JSON.stringify(state));
    } else if (state.updatedAt) {
      dirty = true;
    }
  } catch {
    saveError = "暂未连接到本地记录服务，当前使用浏览器中的学习记录。";
  }
  hydrated = true;
  if (dirty) saveServer();
  notify();
}
export function importProgress(value: unknown) {
  if (!valid(value)) throw new Error("不是有效的学习记录文件");
  persist({ ...empty, ...value });
}
