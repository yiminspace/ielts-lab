export interface SavedRecording {
  id: string;
  itemId: string;
  question: number;
  durationSeconds: number;
  contentType: string;
  size: number;
  createdAt: string;
  audioUrl: string;
}
export interface PendingRecording {
  id: string;
  owner: string;
  itemId: string;
  question: number;
  durationSeconds: number;
  createdAt: string;
  blob: Blob;
}
const DATABASE = "ielts-lab-recording-outbox-v1";
const STORE = "recordings";
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(DATABASE, 1);
    open.onupgradeneeded = () => {
      const store = open.result.createObjectStore(STORE, { keyPath: "id" });
      store.createIndex("owner", "owner");
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => resolve(open.result);
  });
}
async function transaction<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("录音本地保存中断"));
    });
  } finally {
    db.close();
  }
}
export async function stashRecording(recording: PendingRecording) {
  await transaction("readwrite", (store) => store.put(recording));
}
export async function listPendingRecordings(
  owner: string,
  itemId: string,
): Promise<PendingRecording[]> {
  const rows = await transaction("readonly", (store) =>
    store.index("owner").getAll(owner),
  );
  return rows
    .filter((row: PendingRecording) => row.itemId === itemId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function removePendingRecording(id: string) {
  await transaction("readwrite", (store) => store.delete(id));
}
async function readResponse(response: Response) {
  if (!response.ok) {
    const value = await response.json().catch(() => ({}));
    throw new Error(value.error || `录音服务暂不可用（${response.status}）`);
  }
  return response.json();
}
export async function listSavedRecordings(
  itemId: string,
): Promise<SavedRecording[]> {
  const value = await readResponse(
    await fetch(`/api/recordings?${new URLSearchParams({ itemId })}`),
  );
  if (!Array.isArray(value.recordings)) throw new Error("录音列表格式不正确");
  return value.recordings;
}
export async function uploadRecording(
  recording: PendingRecording,
): Promise<SavedRecording> {
  if (!recording.blob.size) throw new Error("录音为空，请重新录制");
  if (recording.blob.size > 32 * 1024 * 1024)
    throw new Error("录音超过 32 MiB，请先下载保留");
  const query = new URLSearchParams({
    itemId: recording.itemId,
    question: String(recording.question),
    durationSeconds: String(recording.durationSeconds),
  });
  return readResponse(
    await fetch(`/api/recordings?${query}`, {
      method: "POST",
      headers: { "Content-Type": recording.blob.type || "audio/webm" },
      body: recording.blob,
    }),
  );
}
export async function deleteSavedRecording(id: string) {
  return readResponse(
    await fetch(`/api/recordings/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  );
}
