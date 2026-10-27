import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, CheckCircle2, Download } from "lucide-react";
import type { ExamPaperDetail } from "../types";
import {
  getProgress,
  saveDraftIfCurrent,
  useProgress,
  useSaveError,
} from "../lib/progress";
import {
  advancePaperRun,
  createPaperRun,
  paperRunKey,
  paperStages,
  restorePaperRun,
  type PaperResult,
  type PaperRun,
  type PaperStage,
} from "../lib/paper-session.mjs";
import ComputerTestSession from "./ComputerTestSession";
import ComputerWriting from "./ComputerWriting";
import "../papers.css";

const names = {
  listening: "Listening",
  reading: "Reading",
  writing: "Writing",
};
const exit = () => {
  location.hash = "/papers";
};

export default function PaperWorkspace({ id }: { id: string }) {
  const [paper, setPaper] = useState<ExamPaperDetail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/papers/" + encodeURIComponent(id), {
      signal: controller.signal,
    })
      .then(async (r) => {
        if (!r.ok) throw new Error("无法打开这套试卷，请返回目录重新选择。");
        return r.json();
      })
      .then(setPaper)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => controller.abort();
  }, [id]);
  if (error)
    return (
      <div className="empty" role="alert">
        <p>{error}</p>
        <button onClick={exit}>返回套卷目录</button>
      </div>
    );
  if (!paper) return <div className="loading">正在准备整套试卷…</div>;
  return <PaperRunView key={paper.id} paper={paper} />;
}

function PaperRunView({ paper }: { paper: ExamPaperDetail }) {
  const progress = useProgress();
  const saveError = useSaveError();
  const key = paperRunKey(paper.id);
  const raw = progress.drafts[key];
  const [run, setRun] = useState<PaperRun | null>(() =>
    restorePaperRun(raw, paper),
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Only this window's successful transition replaces its active section.
  // External progress updates must leave a conflicting editor mounted so its
  // existing conflict/export controls can preserve unsaved local work.

  async function mutate(operation: () => void) {
    setBusy(true);
    try {
      if (navigator.locks)
        await navigator.locks.request("ielts-lab-progress-write", operation);
      else operation();
    } catch (e) {
      setError(e instanceof Error ? e.message : "试卷保存失败，请刷新继续。");
    } finally {
      setBusy(false);
    }
  }
  function start() {
    void mutate(() => {
      const current = getProgress().drafts[key];
      const existing = restorePaperRun(current, paper);
      // Another window may already have started this paper.
      if (existing && existing.phase !== "complete") {
        setRun(existing);
        return;
      }
      const next = createPaperRun(paper, crypto.randomUUID());
      if (!saveDraftIfCurrent(key, next, JSON.stringify(current ?? null)))
        throw new Error("试卷在另一窗口发生了变化，请刷新继续。");
      setRun(next);
      setError("");
    });
  }
  function complete(stage: PaperStage, runId: string, result: PaperResult) {
    void mutate(() => {
      const currentRaw = getProgress().drafts[key];
      const current = restorePaperRun(currentRaw, paper);
      if (!current)
        throw new Error("套卷记录发生了变化，请刷新以读取最新进度。");
      const next = advancePaperRun(current, runId, stage, result);
      if (
        next !== current &&
        !saveDraftIfCurrent(key, next, JSON.stringify(currentRaw))
      )
        throw new Error("另一窗口已更新考试进度，请刷新继续。");
      setRun(next);
    });
  }

  if (run && run.phase !== "complete" && paper.ready) {
    if (error)
      return (
        <div className="paper-screen">
          <div className="paper-sheet" role="alert">
            <h1>进度需要重新同步</h1>
            <p>{error}</p>
            <button className="button" onClick={() => location.reload()}>
              刷新并继续
            </button>
          </div>
        </div>
      );
    const stage = run.phase;
    const items = paper[stage];
    const mode = {
      paperId: paper.id,
      runId: run.runId,
      startedAt: run.stageStartedAt,
      items,
      autoStart: true,
      shortDemo: paper.shortDemo,
      onComplete: (result: PaperResult) => complete(stage, run.runId, result),
    };
    return stage === "writing" ? (
      <ComputerWriting
        key={run.runId + stage}
        item={items[0]}
        onExit={exit}
        paperMode={mode}
      />
    ) : (
      <ComputerTestSession
        key={run.runId + stage}
        item={items[0]}
        onExit={exit}
        paperMode={mode}
      />
    );
  }

  const submitted = run?.phase === "complete";
  const results = run
    ? paperStages.map((stage) => ({
        stage,
        result: run.results[stage],
        attempts: (run.results[stage]?.attemptIds || []).flatMap((id) => {
          const a = progress.attempts.find((entry) => entry.id === id);
          return a ? [a] : [];
        }),
      }))
    : [];
  const exportResult = () => {
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            {
              title: paper.title,
              run,
              attempts: results.flatMap((r) => r.attempts),
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `ielts-general-${run?.runId}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="paper-screen">
      <header className="paper-screen-header">
        <button onClick={exit}>
          <ArrowLeft size={18} /> 套卷目录
        </button>
        <span>IELTS Lab · General Training</span>
        <span>Full-paper practice</span>
      </header>
      <main className="paper-sheet">
        {saveError && (
          <p className="save-warning" role="status">
            {saveError}
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <p className="paper-eyebrow">
          {submitted ? "TEST SUBMITTED" : "BEFORE YOU BEGIN"}
        </p>
        <h1>{submitted ? "本次整卷已交卷" : paper.title}</h1>
        {submitted ? (
          <>
            <p>
              <CheckCircle2 size={20} /> {paper.title} ·
              已保存听力、阅读与两篇作文。
            </p>
            <div className="paper-summary">
              {results.map(({ stage, result, attempts }) => (
                <section key={stage}>
                  <h2>{names[stage]}</h2>
                  <strong>
                    {stage === "writing"
                      ? `${attempts.length} 篇作文`
                      : `${attempts.reduce((n, a) => n + (a.score || 0), 0)} / ${attempts.reduce((n, a) => n + (a.total || 0), 0)}`}
                  </strong>
                  <p>
                    {result?.reason === "timeout"
                      ? "时间到，自动提交"
                      : "已确认提交"}{" "}
                    ·{" "}
                    {result
                      ? Math.ceil(
                          (result.finishedAt - result.startedAt) / 60000,
                        )
                      : 0}{" "}
                    分钟
                  </p>
                  {attempts.map((attempt, i) => (
                    <a
                      key={attempt.id}
                      href={`#/item/${encodeURIComponent(attempt.itemId)}?review=${encodeURIComponent(attempt.id)}`}
                    >
                      {stage === "writing" ? "Task" : "Part"} {i + 1} · 查看作答{" "}
                      <ArrowRight size={13} />
                    </a>
                  ))}
                </section>
              ))}
            </div>
            <p className="paper-note">
              客观题按本地答案核对；作文已保存，未做考官评分。这里不换算官方分数。历史记录也可在“练习记录”中查看。
            </p>
            <div className="paper-actions">
              <button className="button" onClick={exit}>
                返回套卷目录
              </button>
              <button className="button secondary" onClick={exportResult}>
                <Download size={16} /> 导出本次作答
              </button>
              <button
                className="button secondary"
                disabled={busy}
                onClick={start}
              >
                重新练习整卷
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              听力 → 阅读 → 写作，依次完成。建议戴好耳机，在电脑上全屏作答。
            </p>
            {paper.shortDemo && (
              <p className="paper-demo-notice">
                原创短流程演示：四段录音重复，听力 {paper.listeningMarks}{" "}
                题、阅读 {paper.readingMarks} 题，用于体验操作。阅读和写作仍各为
                60 分钟；这不是完整真题。
              </p>
            )}
            <ol className="paper-steps">
              <li>
                <b>Listening</b>
                <span>4 Parts · {paper.listeningMarks} 题</span>
                <p>
                  四段录音顺序播放一次。切题不改变播放位置，全部结束后有 2
                  分钟检查。
                </p>
              </li>
              <li>
                <b>Reading</b>
                <span>3 Sections · {paper.readingMarks} 题 · 60 分钟</span>
                <p>
                  可以在三部分之间切换。共用一个计时器，提交后不能返回修改。
                </p>
              </li>
              <li>
                <b>Writing</b>
                <span>2 Tasks · 共用 60 分钟</span>
                <p>
                  Task 1 写信至少 150 词；Task 2 议论文至少 250
                  词。可自由切题，建议分配 20 / 40 分钟。
                </p>
              </li>
            </ol>
            <p className="paper-note">
              每科交卷后自动开始下一科，阅读和写作离开页面后仍计时；超时自动提交。刷新后录音需点击
              Resume 恢复。这是本地练习的恢复机制，正式考试请遵从考点指引。
            </p>
            {!paper.ready && (
              <p className="paper-issue" role="alert">
                这套材料暂未通过完整性检查：{paper.issues.join("；")}
              </p>
            )}
            {raw && !run && (
              <p className="paper-issue">
                旧套卷记录与当前材料不匹配；开始新一轮将替换续考入口，已有练习记录仍保留。
              </p>
            )}
            <div className="paper-actions">
              <button
                className="button"
                onClick={start}
                disabled={busy || !paper.ready}
              >
                Start full test <ArrowRight size={18} />
              </button>
              <button className="button secondary" onClick={exit}>
                返回目录
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
