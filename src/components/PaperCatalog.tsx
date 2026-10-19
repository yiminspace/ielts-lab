import { useEffect, useState } from "react";
import { ArrowRight, Headphones } from "lucide-react";
import type { ExamPaper } from "../types";
import { useProgress } from "../lib/progress";
import { paperRunKey, restorePaperRun } from "../lib/paper-session.mjs";
import "../papers.css";

export default function PaperCatalog() {
  const [papers, setPapers] = useState<ExamPaper[] | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const progress = useProgress();
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/papers", { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error("套卷目录加载失败");
        return r.json();
      })
      .then((data) => setPapers(data.papers))
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => controller.abort();
  }, []);
  const archived = papers?.filter((p) => p.source === "archive") || [];
  return (
    <section className="paper-catalog">
      <div className="page-heading">
        <div>
          <p className="paper-eyebrow">General Training · 机考练习</p>
          <h1>G 类完整套卷</h1>
          <p>听力、阅读、写作连续进行。每一科提交后自动进入下一科。</p>
        </div>
      </div>
      <div className="paper-rules-strip">
        <span>
          <Headphones size={19} /> Listening · 4 Parts + 2 分钟检查
        </span>
        <span>Reading · 3 Sections / 60 分钟</span>
        <span>Writing · 2 Tasks / 共用 60 分钟</span>
      </div>
      <p className="paper-note">
        参照官方机考的流程与操作；口语单独练习。归档听力按原有四段音频连续播放，录音中的提示与停顿可能不同于考场。
      </p>
      {error ? (
        <p role="alert">{error}</p>
      ) : !papers ? (
        <div className="loading">正在核对套卷…</div>
      ) : (
        <>
          <div className="paper-filter">
            <label>
              查找套卷
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="例如 C18、Test 1"
              />
            </label>
            <span>
              {archived.filter((p) => p.ready).length} 套完整归档 ·{" "}
              {archived.filter((p) => !p.ready).length} 套待核对
            </span>
          </div>
          <div className="paper-grid">
            {papers
              .filter((p) =>
                `${p.title} ${p.collection}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              )
              .map((paper) => {
                const run = restorePaperRun(
                  progress.drafts[paperRunKey(paper.id)],
                  paper,
                );
                return (
                  <article
                    className={
                      "paper-card " + (!paper.ready ? "paper-incomplete" : "")
                    }
                    key={paper.id}
                  >
                    <div className="paper-card-top">
                      <span>
                        {paper.shortDemo ? "原创短流程演示" : paper.collection}
                      </span>
                      <span>
                        {paper.shortDemo
                          ? "非完整试卷"
                          : paper.ready
                            ? "完整套卷"
                            : "待核对"}
                      </span>
                    </div>
                    <h2>{paper.title}</h2>
                    <p>
                      {paper.listeningMarks ?? "—"} 道听力 ·{" "}
                      {paper.readingMarks ?? "—"} 道阅读 · 2 篇写作
                    </p>
                    {paper.shortDemo && (
                      <p className="paper-note">
                        4 段重复短录音用于熟悉流程，写作仍共用真实 60 分钟。
                      </p>
                    )}
                    {!paper.ready && (
                      <p className="paper-issue">{paper.issues.join("；")}</p>
                    )}
                    <button
                      className="button secondary"
                      disabled={!paper.ready}
                      onClick={() => {
                        location.hash =
                          "/paper/" + encodeURIComponent(paper.id);
                      }}
                    >
                      {run?.phase === "complete"
                        ? "查看交卷结果"
                        : run
                          ? "继续整卷"
                          : "开始整卷"}
                      <ArrowRight size={17} />
                    </button>
                  </article>
                );
              })}
          </div>
        </>
      )}
    </section>
  );
}
