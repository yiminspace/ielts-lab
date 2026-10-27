import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Trash2, RotateCcw } from "lucide-react";
import { VoyageStateView } from "@yiminlab/voyage/react";
import {
  deleteSavedRecording,
  listPendingRecordings,
  listSavedRecordings,
  removePendingRecording,
  stashRecording,
  uploadRecording,
  type PendingRecording,
  type SavedRecording,
} from "../lib/recordings";
import { useRuntime } from "../lib/runtime";

export interface NewRecording {
  id: string;
  blob: Blob;
  question: number;
  durationSeconds: number;
}
type LocalRow = PendingRecording & {
  url: string;
  status: "pending" | "uploading" | "saved" | "error";
  error?: string;
  savedId?: string;
};
const extension = (type: string) =>
  type.includes("mp4")
    ? "m4a"
    : type.includes("ogg")
      ? "ogg"
      : type.includes("wav")
        ? "wav"
        : "webm";

export default function SpeakingRecordings({
  itemId,
  title,
  recording,
}: {
  itemId: string;
  title: string;
  recording: NewRecording | null;
}) {
  const { config, userId } = useRuntime();
  const owner = userId || "local";
  const [local, setLocal] = useState<LocalRow[]>([]);
  const [saved, setSaved] = useState<SavedRecording[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const mounted = useRef(true);
  const urls = useRef(new Map<string, string>());
  const handled = useRef(new Set<string>());
  const uploading = useRef(new Set<string>());
  const makeRow = useCallback((row: PendingRecording): LocalRow => {
    let url = urls.current.get(row.id);
    if (!url) {
      url = URL.createObjectURL(row.blob);
      urls.current.set(row.id, url);
    }
    return { ...row, url, status: "pending" };
  }, []);
  const refresh = useCallback(async () => {
    try {
      const rows = await listSavedRecordings(itemId);
      if (mounted.current) {
        setSaved(rows);
        setLocal((current) =>
          current.filter(
            (value) =>
              value.status !== "saved" ||
              rows.some((row) => row.id === value.savedId),
          ),
        );
        setError("");
      }
    } catch (error) {
      if (mounted.current) setError((error as Error).message);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [itemId]);
  const save = useCallback(async (row: LocalRow) => {
    if (uploading.current.has(row.id)) return;
    uploading.current.add(row.id);
    setLocal((rows) =>
      rows.map((value) =>
        value.id === row.id
          ? { ...value, status: "uploading", error: "" }
          : value,
      ),
    );
    try {
      const result = await uploadRecording(row);
      // A network acknowledgement is required before removing the local outbox copy.
      await removePendingRecording(row.id).catch(() => {});
      if (mounted.current) {
        setSaved((rows) => [
          result,
          ...rows.filter((value) => value.id !== result.id),
        ]);
        setLocal((rows) =>
          rows.map((value) =>
            value.id === row.id
              ? { ...value, status: "saved", savedId: result.id }
              : value,
          ),
        );
      }
    } catch (error) {
      if (mounted.current)
        setLocal((rows) =>
          rows.map((value) =>
            value.id === row.id
              ? { ...value, status: "error", error: (error as Error).message }
              : value,
          ),
        );
    } finally {
      uploading.current.delete(row.id);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    void listPendingRecordings(owner, itemId)
      .then((rows) => {
        if (!active) return;
        setLocal((current) => [
          ...current,
          ...rows
            .filter((row) => !current.some((value) => value.id === row.id))
            .map(makeRow),
        ]);
      })
      .catch(() => {
        if (active)
          setError("浏览器暂不能恢复待上传录音；新录音仍可回听和下载。");
      });
    void refresh();
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      mounted.current = false;
      document.removeEventListener("visibilitychange", onVisible);
      for (const url of urls.current.values()) URL.revokeObjectURL(url);
      urls.current.clear();
    };
  }, [owner, itemId, makeRow, refresh]);
  useEffect(() => {
    if (!recording || handled.current.has(recording.id)) return;
    handled.current.add(recording.id);
    const pending: PendingRecording = {
      ...recording,
      owner,
      itemId,
      createdAt: new Date().toISOString(),
    };
    const row = makeRow(pending);
    setLocal((rows) => [row, ...rows]);
    void (async () => {
      try {
        await stashRecording(pending);
      } catch {
        if (mounted.current)
          setError(
            "浏览器空间不足，待上传录音仅保留在当前页面，请先下载备份。",
          );
      }
      await save(row);
    })();
  }, [recording, owner, itemId, makeRow, save]);
  useEffect(() => {
    if (!local.some((row) => row.status !== "saved")) return;
    const beforeLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeLeave);
    return () => window.removeEventListener("beforeunload", beforeLeave);
  }, [local]);
  async function remove(row: SavedRecording) {
    if (!window.confirm("删除这条已保存的录音？此操作会同时移除服务端文件。"))
      return;
    setBusy(row.id);
    try {
      await deleteSavedRecording(row.id);
      setSaved((rows) => rows.filter((value) => value.id !== row.id));
      setLocal((rows) => rows.filter((value) => value.savedId !== row.id));
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function downloadSaved(row: SavedRecording) {
    setBusy(row.id);
    try {
      const response = await fetch(row.audioUrl);
      if (!response.ok) throw new Error("录音下载失败，请稍后重试。");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `${title}-${row.question + 1}.${extension(row.contentType)}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function discard(row: LocalRow) {
    if (!window.confirm("移除这条本机待上传录音？请先下载需要保留的内容。"))
      return;
    try {
      await removePendingRecording(row.id);
      URL.revokeObjectURL(row.url);
      urls.current.delete(row.id);
      setLocal((rows) => rows.filter((value) => value.id !== row.id));
    } catch {
      setError("无法移除本机录音，请重试。");
    }
  }
  async function recoverAudio(event: React.SyntheticEvent<HTMLAudioElement>) {
    const audio = event.currentTarget;
    if (audio.dataset.recovering) return;
    audio.dataset.recovering = "true";
    try {
      if ((await fetch(audio.currentSrc, { method: "HEAD" })).ok) audio.load();
    } catch {
      setError("录音播放失败，请恢复连接后刷新列表。");
    }
  }
  const visibleSaved = saved.filter(
    (row) => !local.some((value) => value.savedId === row.id),
  );
  return (
    <section className="study-saved-recordings" aria-label="口语录音">
      <div className="study-toolbar">
        <h2>我的录音</h2>
        <button
          className="vg-btn"
          onClick={() => {
            void refresh();
          }}
        >
          <RotateCcw size={15} /> 刷新列表
        </button>
      </div>
      <p className="study-muted">
        {config.authRequired
          ? "已保存的录音可在你的其他设备继续回听。"
          : "录音保存到当前服务，可回听、下载或删除。"}{" "}
        上传失败时仍可本机回听、下载和重试。
      </p>
      {error && (
        <p className="study-warning" role="alert">
          {error}
        </p>
      )}
      {local.map((row) => (
        <article className="study-recorded" key={row.id}>
          <strong>
            第 {row.question + 1} 题 · {Math.round(row.durationSeconds)} 秒
          </strong>
          <span className="study-muted">
            {new Date(row.createdAt).toLocaleString("zh-CN")} ·{" "}
            {row.status === "saved"
              ? "已保存"
              : row.status === "uploading"
                ? "正在上传…"
                : "待上传，本机可回听"}
          </span>
          <audio controls preload="none" src={row.url} />
          <div className="button-group">
            <a
              className="vg-btn"
              href={row.url}
              download={`${title}-${row.question + 1}.${extension(row.blob.type)}`}
            >
              <Download size={15} /> 下载本机录音
            </a>
            {row.status !== "saved" && (
              <>
                <button
                  className="vg-btn"
                  disabled={row.status === "uploading"}
                  onClick={() => {
                    void save(row);
                  }}
                >
                  {row.status === "uploading" ? "上传中…" : "重试上传"}
                </button>
                <button
                  className="vg-btn"
                  disabled={row.status === "uploading"}
                  onClick={() => {
                    void discard(row);
                  }}
                >
                  移除本机副本
                </button>
              </>
            )}
            {row.status === "saved" &&
              saved.find((value) => value.id === row.savedId) && (
                <button
                  className="vg-btn"
                  disabled={busy === row.savedId}
                  onClick={() => {
                    void remove(
                      saved.find((value) => value.id === row.savedId)!,
                    );
                  }}
                >
                  <Trash2 size={15} /> 删除
                </button>
              )}
          </div>
          {row.error && (
            <p className="study-warning" role="alert">
              {row.error}
            </p>
          )}
        </article>
      ))}
      {loading && (
        <VoyageStateView
          variant="loading"
          size="section"
          heading="正在加载录音"
        />
      )}
      {!loading && !local.length && !saved.length && !error && (
        <p className="study-muted">还没有保存的录音。录制后会自动上传。</p>
      )}
      {visibleSaved.map((row) => (
        <article className="study-recorded" key={row.id}>
          <strong>
            第 {row.question + 1} 题 · {Math.round(row.durationSeconds)} 秒
          </strong>
          <span className="study-muted">
            {new Date(row.createdAt).toLocaleString("zh-CN")} · 已保存
          </span>
          <audio
            controls
            preload="none"
            src={row.audioUrl}
            onError={recoverAudio}
          />
          <div className="button-group">
            <button
              className="vg-btn"
              disabled={busy === row.id}
              onClick={() => {
                void downloadSaved(row);
              }}
            >
              <Download size={15} /> 下载录音
            </button>
            <button
              className="vg-btn"
              disabled={busy === row.id}
              onClick={() => {
                void remove(row);
              }}
            >
              <Trash2 size={15} /> 删除
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
