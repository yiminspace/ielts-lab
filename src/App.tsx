import { Component, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Bookmark,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Download,
  FileText,
  GraduationCap,
  Headphones,
  History,
  LayoutDashboard,
  ListChecks,
  Menu,
  Mic,
  PenLine,
  Search,
  Settings,
  SlidersHorizontal,
  SpellCheck,
  Volume2,
  X,
} from "lucide-react";
import type { Kind, Library, LibraryItem, StudyItem } from "./types";
import {
  getProgress,
  hydrateProgress,
  importProgress,
  saveNote,
  toggleBookmark,
  useProgress,
  useSaveError,
} from "./lib/progress";
import ExamWorkspace from "./components/ExamWorkspace";
import StudyWorkspace from "./components/StudyWorkspace";
import ComputerTestSession from "./components/ComputerTestSession";
import ComputerWriting from "./components/ComputerWriting";
import { matchesTestTrack } from "./lib/test-track.mjs";

type TrackChoice = "general" | "academic" | "all";
const trackNames = {
  general: "G 类 · 培训类",
  academic: "A 类 · 学术类",
  shared: "A / G 通用",
  unclassified: "类别待确认",
};
function initialTrack(): TrackChoice {
  try {
    const saved = localStorage.getItem("ielts-lab-test-track");
    if (["general", "academic", "all"].includes(saved || ""))
      return saved as TrackChoice;
  } catch {
    /* use the requested G direction when preferences are unavailable */
  }
  return "general";
}
function MaterialLabels({ item }: { item: LibraryItem }) {
  return (
    <span className="material-labels">
      <span>{trackNames[item.testTrack || "unclassified"]}</span>
      {item.source === "original" && <span>原创练习 · 非官方真题</span>}
    </span>
  );
}

const kinds: {
  id: Kind;
  name: string;
  icon: typeof Headphones;
  short: string;
}[] = [
  { id: "listening", name: "听力练习", icon: Headphones, short: "听" },
  { id: "reading", name: "阅读练习", icon: BookOpen, short: "读" },
  { id: "writing", name: "写作练习", icon: PenLine, short: "写" },
  { id: "speaking", name: "口语练习", icon: Mic, short: "说" },
  { id: "vocabulary", name: "词汇学习", icon: SpellCheck, short: "词" },
  { id: "sentences", name: "句子听写", icon: Volume2, short: "句" },
  { id: "grammar", name: "长难句分析", icon: FileText, short: "析" },
  { id: "numbers", name: "数字听写", icon: ListChecks, short: "数" },
  { id: "typing", name: "打字练习", icon: PenLine, short: "练" },
  { id: "courses", name: "公开课", icon: GraduationCap, short: "课" },
];
function label(kind: string) {
  return kinds.find((k) => k.id === kind)?.name || kind;
}
function navigate(path: string) {
  window.location.hash = path;
}
function useRoute() {
  const [route, setRoute] = useState(location.hash.slice(1) || "/");
  useEffect(() => {
    const update = () => setRoute(location.hash.slice(1) || "/");
    addEventListener("hashchange", update);
    return () => removeEventListener("hashchange", update);
  }, []);
  return route;
}
function date(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function downloadJSON(name: string, value: unknown) {
  const u = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = u;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}

class Boundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: "" };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    if (this.state.error)
      return (
        <div className="empty">
          <h2>这份材料暂时未能显示</h2>
          <p>{this.state.error}</p>
          <button
            onClick={() => {
              this.setState({ error: "" });
              navigate("/");
            }}
          >
            返回资料库
          </button>
        </div>
      );
    return this.props.children;
  }
}

export default function App() {
  const fullRoute = useRoute();
  const [route, query = ""] = fullRoute.split("?");
  const progress = useProgress();
  const saveError = useSaveError();
  const reviewAttempt = progress.attempts.find(
    (a) => a.id === new URLSearchParams(query).get("review"),
  );
  const [library, setLibrary] = useState<Library | null>(null);
  const [error, setError] = useState("");
  const [menu, setMenu] = useState(false);
  const [search, setSearch] = useState("");
  const [item, setItem] = useState<StudyItem | null>(null);
  const [itemError, setItemError] = useState("");
  const [testTrack, setTestTrack] = useState<TrackChoice>(initialTrack);
  const selectTrack = (next: TrackChoice) => {
    setTestTrack(next);
    setSearch("");
    try {
      localStorage.setItem("ielts-lab-test-track", next);
    } catch {
      /* session preference still works */
    }
  };
  const scopedLibrary = useMemo(() => {
    if (!library) return null;
    const items = library.items.filter((entry) =>
      matchesTestTrack(entry, testTrack),
    );
    const counts: Library["counts"] = {};
    items.forEach((entry) => {
      counts[entry.kind] = (counts[entry.kind] || 0) + 1;
    });
    return { ...library, items, counts };
  }, [library, testTrack]);
  const lastAttempt = progress.attempts.find((attempt) =>
    scopedLibrary?.items.some((entry) => entry.id === attempt.itemId),
  );
  const computerMode = route.startsWith("/exam/");
  const itemId =
    route.startsWith("/item/") || computerMode
      ? decodeURIComponent(route.slice(6))
      : "";
  const section = route.split("/")[1] || "home";
  const kind = route.split("/")[2] as Kind;
  useEffect(() => {
    let disposed = false;
    fetch("/api/library")
      .then(async (r) => {
        if (!r.ok) throw new Error("资料库加载失败");
        return r.json();
      })
      .then(async (data: Library) => {
        if (!disposed) {
          await hydrateProgress(data.mode);
          if (!disposed) setLibrary(data);
        }
      })
      .catch((e) => {
        if (!disposed) setError(String(e.message));
      });
    return () => {
      disposed = true;
    };
  }, []);
  useEffect(() => {
    setMenu(false);
    setSearch("");
  }, [route]);
  useEffect(() => {
    setItem(null);
    setItemError("");
    if (!itemId) return;
    const c = new AbortController();
    fetch("/api/items/" + encodeURIComponent(itemId), { signal: c.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error("没有找到这份材料，请返回资料库重新选择");
        return r.json();
      })
      .then(setItem)
      .catch((e) => {
        if (e.name !== "AbortError") setItemError(e.message);
      });
    return () => c.abort();
  }, [itemId]);
  const activeKind = item?.kind || (section === "library" ? kind : null);
  const title =
    section === "home"
      ? "学习空间"
      : section === "library"
        ? label(kind)
        : section === "history"
          ? "练习记录"
          : section === "mistakes"
            ? "错题复习"
            : section === "bookmarks"
              ? "我的收藏"
              : section === "settings"
                ? "资料与设置"
                : item?.title || "正在打开材料";
  const stats = useMemo(() => {
    const attempts = progress.attempts;
    const scored = attempts.filter(
      (a) =>
        a.total &&
        ["listening", "reading", "sentences", "numbers"].includes(a.kind),
    );
    return {
      finished: new Set(attempts.map((a) => a.itemId)).size,
      minutes: Math.round(
        attempts.reduce((s, a) => s + (a.durationSeconds || 0), 0) / 60,
      ),
      accuracy: scored.length
        ? Math.round(
            (scored.reduce((s, a) => s + (a.score || 0), 0) /
              scored.reduce((s, a) => s + a.total!, 0)) *
              100,
          )
        : null,
    };
  }, [progress.attempts]);
  if (computerMode) {
    const exit = () => navigate("/item/" + encodeURIComponent(itemId));
    return (
      <>
        {error || itemError ? (
          <div className="empty">
            <h2>{error || itemError}</h2>
            <button onClick={exit}>返回学习模式</button>
          </div>
        ) : !library || !item ? (
          <div className="loading">
            <span className="spinner" />
            正在打开机考练习…
          </div>
        ) : (
          <Boundary key={"exam:" + item.id}>
            {item.kind === "writing" ? (
              <ComputerWriting item={item} onExit={exit} />
            ) : ["listening", "reading"].includes(item.kind) ? (
              <ComputerTestSession item={item} onExit={exit} />
            ) : (
              <div className="empty">
                <p>这类材料使用学习模式。</p>
                <button onClick={exit}>返回</button>
              </div>
            )}
          </Boundary>
        )}
      </>
    );
  }
  return (
    <div className={"app-shell " + (itemId ? "studying" : "")}>
      {menu && (
        <button
          aria-label="关闭导航"
          className="nav-overlay"
          onClick={() => setMenu(false)}
        />
      )}
      <aside className={"sidebar " + (menu ? "open" : "")}>
        <a className="brand" href="#/">
          <span className="brand-symbol">
            <BookOpen size={23} />
          </span>
          <span>
            IELTS Lab<small>雅思练习室</small>
          </span>
        </a>
        <nav aria-label="主导航">
          <a
            className={"nav-item " + (section === "home" ? "active" : "")}
            href="#/"
          >
            <LayoutDashboard size={18} />
            学习空间
          </a>
          <div className="nav-label">专项练习</div>
          {kinds.map((k, i) => (
            <a
              className={
                "nav-item " +
                (activeKind === k.id ? "active" : "") +
                (i === 4 ? " nav-gap" : "")
              }
              href={"#/library/" + k.id}
              key={k.id}
            >
              <k.icon size={18} />
              <span>{k.name}</span>
              <span className="nav-count">
                {scopedLibrary?.counts?.[k.id] || 0}
              </span>
            </a>
          ))}
          <div className="nav-label">我的学习</div>
          {[
            { id: "history", icon: History, text: "练习记录" },
            { id: "mistakes", icon: ListChecks, text: "错题复习" },
            { id: "bookmarks", icon: Bookmark, text: "我的收藏" },
          ].map((n) => (
            <a
              key={n.id}
              className={"nav-item " + (section === n.id ? "active" : "")}
              href={"#/" + n.id}
            >
              <n.icon size={18} />
              {n.text}
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <a
            className={"nav-item " + (section === "settings" ? "active" : "")}
            href="#/settings"
          >
            <Settings size={18} />
            资料与设置
          </a>
          <div className="storage-status">
            <span className="status-dot" />
            {library?.mode === "archive" ? "本地资料已连接" : "原创示例资料"}
            <small>学习记录保存在本机</small>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="topbar-title">
            <button
              className="icon-button mobile-menu"
              aria-label="打开导航"
              onClick={() => setMenu(true)}
            >
              <Menu size={21} />
            </button>
            {itemId && (
              <button
                className="icon-button"
                aria-label="返回资料列表"
                onClick={() =>
                  navigate("/library/" + (item?.kind || "listening"))
                }
              >
                <ArrowLeft size={19} />
              </button>
            )}
            <span>{title}</span>
          </div>
          <div className="topbar-right">
            {!itemId && ["home", "library", "bookmarks"].includes(section) && (
              <label className="track-picker">
                <span>备考类型</span>
                <select
                  aria-label="备考类型"
                  value={testTrack}
                  onChange={(e) => selectTrack(e.target.value as TrackChoice)}
                >
                  <option value="general">G 类 · General Training</option>
                  <option value="academic">A 类 · Academic</option>
                  <option value="all">全部资料（含待确认）</option>
                </select>
              </label>
            )}
            <span className="local-badge">
              {library?.mode === "archive" ? "个人资料库" : "示例模式"}
            </span>
            <span className="avatar" aria-label="个人空间">
              我
            </span>
          </div>
        </header>
        {saveError && (
          <div className="save-warning" role="status">
            {saveError}
          </div>
        )}
        <main className={itemId ? "workspace-main" : "page-main"}>
          {library &&
            !itemId &&
            ["home", "library", "bookmarks"].includes(section) && (
              <TrackGuide
                library={library}
                choice={testTrack}
                onShowAll={() => selectTrack("all")}
              />
            )}
          {error ? (
            <div className="empty">
              <h2>{error}</h2>
              <p>请确认本地服务仍在运行，然后刷新页面。</p>
              <button onClick={() => location.reload()}>重新加载</button>
            </div>
          ) : !library ? (
            <div className="loading">
              <span className="spinner" />
              正在整理资料目录…
            </div>
          ) : itemId ? (
            <>
              {itemError ? (
                <div className="empty">{itemError}</div>
              ) : !item ? (
                <div className="loading">
                  <span className="spinner" />
                  正在打开练习…
                </div>
              ) : (
                <Boundary key={item.id + (reviewAttempt?.id || "")}>
                  <div className="item-toolbar">
                    <div>
                      <span className="muted">{item.collection}</span>
                      <h1>{item.title}</h1>
                      <MaterialLabels item={item} />
                    </div>
                    <button
                      className={
                        "button secondary " +
                        (progress.bookmarks.includes(item.id) ? "selected" : "")
                      }
                      onClick={() => toggleBookmark(item.id)}
                    >
                      <Bookmark
                        size={16}
                        fill={
                          progress.bookmarks.includes(item.id)
                            ? "currentColor"
                            : "none"
                        }
                      />
                      {progress.bookmarks.includes(item.id) ? "已收藏" : "收藏"}
                    </button>
                  </div>
                  {["listening", "reading", "writing"].includes(item.kind) &&
                    !reviewAttempt && (
                      <div className="computer-entry">
                        <div>
                          <strong>用机考界面练习</strong>
                          <p>
                            参照 IDP
                            官方熟悉测试的布局与操作。当前练习这一节材料。
                          </p>
                        </div>
                        <button
                          className="button"
                          onClick={() =>
                            navigate("/exam/" + encodeURIComponent(item.id))
                          }
                        >
                          进入机考界面 <ArrowRight size={17} />
                        </button>
                      </div>
                    )}
                  {["listening", "reading"].includes(item.kind) ? (
                    <ExamWorkspace item={item} reviewAttempt={reviewAttempt} />
                  ) : (
                    <StudyWorkspace item={item} reviewAttempt={reviewAttempt} />
                  )}
                  <details className="study-note">
                    <summary>
                      学习笔记{progress.notes[item.id] ? " · 已保存" : ""}
                    </summary>
                    <textarea
                      aria-label="学习笔记"
                      value={progress.notes[item.id] || ""}
                      placeholder="记下容易混淆的表达，或者下次复习要注意的地方…"
                      onChange={(e) => saveNote(item.id, e.target.value)}
                    />
                  </details>
                </Boundary>
              )}
            </>
          ) : section === "home" ? (
            <>
              <div className="page-heading">
                <div>
                  <p className="muted">
                    {new Date().toLocaleDateString("zh-CN", {
                      month: "long",
                      day: "numeric",
                      weekday: "long",
                    })}
                  </p>
                  <h1>自己的节奏，扎实地练习。</h1>
                  <p>从一份材料开始，把答案、原文和错题放在一起。</p>
                </div>
                <button
                  className="button secondary"
                  onClick={() => navigate("/history")}
                >
                  <History size={16} />
                  查看记录
                </button>
              </div>
              <div className="overview-stats">
                <div>
                  <span>全部类型已练材料</span>
                  <strong>
                    {stats.finished}
                    <small>份</small>
                  </strong>
                </div>
                <div>
                  <span>全部累计练习</span>
                  <strong>
                    {stats.minutes}
                    <small>分钟</small>
                  </strong>
                </div>
                <div>
                  <span>全部客观题正确率</span>
                  <strong>
                    {stats.accuracy === null ? "—" : stats.accuracy + "%"}
                  </strong>
                </div>
                <div>
                  <span>全部收藏材料</span>
                  <strong>
                    {progress.bookmarks.length}
                    <small>份</small>
                  </strong>
                </div>
              </div>
              <div className="home-grid">
                <section className="start-panel">
                  <div className="section-heading">
                    <h2>四项专项练习</h2>
                    <span className="muted">按材料自由选择</span>
                  </div>
                  <div className="skills-grid">
                    {kinds.slice(0, 4).map((k, i) => (
                      <button
                        className={"skill-tile skill-" + k.id}
                        key={k.id}
                        onClick={() => navigate("/library/" + k.id)}
                      >
                        <k.icon size={25} />
                        <h3>{k.name}</h3>
                        <p>
                          {
                            [
                              "整篇刷题 · 逐句精听",
                              "原文对照 · 答案解析",
                              "计时写作 · 草稿保存",
                              "题目播音 · 录音回听",
                            ][i]
                          }
                        </p>
                        <span>
                          {scopedLibrary?.counts[k.id] || 0} 份材料{" "}
                          <ArrowRight size={16} />
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
                <section className="resume-panel">
                  <div className="section-heading">
                    <h2>继续学习</h2>
                    <Clock3 size={18} />
                  </div>
                  {lastAttempt ? (
                    <>
                      <span className="tag">{label(lastAttempt.kind)}</span>
                      <h3>{lastAttempt.title}</h3>
                      <p className="muted">
                        上次练习：{date(lastAttempt.createdAt)}
                      </p>
                      <button
                        className="button"
                        onClick={() =>
                          navigate(
                            "/item/" + encodeURIComponent(lastAttempt.itemId),
                          )
                        }
                      >
                        继续复习
                        <ArrowRight size={16} />
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="resume-illustration">
                        <Headphones size={47} />
                        <span className="wave-bars">▂ ▅ ▃ ▇ ▅ ▂ ▆</span>
                      </div>
                      <h3>先完成一篇听力</h3>
                      <p>做题后可查看答案和解析，再回到原文逐句精听。</p>
                      <button
                        className="button"
                        onClick={() => navigate("/library/listening")}
                      >
                        选择听力材料
                        <ArrowRight size={16} />
                      </button>
                    </>
                  )}
                </section>
              </div>
              <section className="foundation">
                <div className="section-heading">
                  <h2>每天一点基础练习</h2>
                </div>
                <div className="foundation-grid">
                  {kinds.slice(4).map((k) => (
                    <button
                      key={k.id}
                      onClick={() => navigate("/library/" + k.id)}
                    >
                      <k.icon size={21} />
                      <div>
                        <strong>{k.name}</strong>
                        <small>{scopedLibrary?.counts[k.id] || 0} 份材料</small>
                      </div>
                      <ChevronRight size={16} />
                    </button>
                  ))}
                </div>
              </section>
              {library.mode === "demo" && (
                <div className="info-banner">
                  <BookOpen size={20} />
                  <div>
                    <strong>正在浏览原创示例</strong>
                    <p>连接本地资料库后，这里会显示你的书册、题目与原音频。</p>
                  </div>
                  <button
                    className="text-button"
                    onClick={() => navigate("/settings")}
                  >
                    导入说明
                  </button>
                </div>
              )}
            </>
          ) : section === "library" || section === "bookmarks" ? (
            <Catalog
              key={testTrack + ":" + kind + ":" + section}
              library={scopedLibrary || library}
              kind={section === "library" ? kind : undefined}
              bookmarksOnly={section === "bookmarks"}
              search={search}
              setSearch={setSearch}
            />
          ) : section === "history" || section === "mistakes" ? (
            <HistoryView mistakes={section === "mistakes"} />
          ) : section === "settings" ? (
            <SettingsView library={library} />
          ) : (
            <div className="empty">
              <h2>没有找到这个页面</h2>
              <a href="#/">返回学习空间</a>
            </div>
          )}
        </main>
        {!itemId && (
          <footer className="page-footer">
            <span>IELTS Lab</span>
            <span>专注练习，记录每一次进步。</span>
          </footer>
        )}
      </div>
    </div>
  );
}

function TrackGuide({
  library,
  choice,
  onShowAll,
}: {
  library: Library;
  choice: TrackChoice;
  onShowAll: () => void;
}) {
  const unknown = library.items.filter(
    (entry) =>
      (!entry.testTrack || entry.testTrack === "unclassified") &&
      ["reading", "writing"].includes(entry.kind),
  ).length;
  const selected = library.items.filter((entry) => entry.testTrack === choice);
  const archived = selected.filter(
    (entry) => entry.source === "archive",
  ).length;
  const original = selected.filter(
    (entry) => entry.source === "original",
  ).length;
  return (
    <section className="track-guide" aria-label="备考类型说明">
      <div>
        <strong>{choice === "all" ? "全部资料" : trackNames[choice]}</strong>
        <p>
          {choice === "general"
            ? "阅读侧重生活和职场场景；写作 Task 1 练书信，Task 2 练议论文。听力和口语与 A 类共用。"
            : choice === "academic"
              ? "阅读偏学术题材；写作 Task 1 描述图表、地图或流程，Task 2 练议论文。听力和口语与 G 类共用。"
              : "这里保留全部归档、原创练习与类别待确认的材料。切换备考类型只筛选目录，不会删除作答和收藏。"}
        </p>
        {choice !== "all" && (
          <p className="track-inventory">
            本类专属：{archived} 份归档 · {original}{" "}
            份原创练习；另包含通用听说与基础材料。
            {unknown > 0 && (
              <>
                {" "}
                还有 {unknown} 份读写材料类别待确认，
                <button className="text-button" onClick={onShowAll}>
                  查看全部资料
                </button>
                。
              </>
            )}
          </p>
        )}
      </div>
      <a
        href="https://ielts.org/take-a-test/preparation-resources/sample-test-questions/general-training-test"
        target="_blank"
        rel="noreferrer"
      >
        官方 G 类样题
      </a>
    </section>
  );
}

function Catalog({
  library,
  kind,
  bookmarksOnly,
  search,
  setSearch,
}: {
  library: Library;
  kind?: Kind;
  bookmarksOnly: boolean;
  search: string;
  setSearch: (s: string) => void;
}) {
  const progress = useProgress();
  const [collection, setCollection] = useState("全部");
  const [filter, setFilter] = useState("all");
  const [visible, setVisible] = useState(60);
  useEffect(() => {
    setCollection("全部");
    setVisible(60);
    setFilter("all");
  }, [kind, bookmarksOnly]);
  useEffect(() => setVisible(60), [search, collection, filter]);
  const base = useMemo(
    () =>
      library.items.filter(
        (i) =>
          (!kind || i.kind === kind) &&
          (!bookmarksOnly || progress.bookmarks.includes(i.id)),
      ),
    [library, kind, bookmarksOnly, progress.bookmarks],
  );
  const collections = useMemo(
    () =>
      [...new Set(base.map((i) => i.collection))].sort((a, b) =>
        b.localeCompare(a, "zh-CN", { numeric: true }),
      ),
    [base],
  );
  const completed = new Set(progress.attempts.map((a) => a.itemId));
  const filtered = base.filter(
    (i) =>
      (collection === "全部" || i.collection === collection) &&
      (!search ||
        (i.title + " " + i.collection)
          .toLowerCase()
          .includes(search.toLowerCase())) &&
      (filter === "all" ||
        (filter === "done" ? completed.has(i.id) : !completed.has(i.id))),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{bookmarksOnly ? "我的收藏" : label(kind || "")}</h1>
          <p>
            {kind === "listening"
              ? "先完整作答，再用原文和逐句播放精听。"
              : kind === "reading"
                ? "专注阅读，在原文中找到答案的依据。"
                : "选择一份材料，开始今天的练习。"}
          </p>
        </div>
        <span className="result-count">{base.length} 份材料</span>
      </div>
      <div className="catalog-tools">
        <label className="search-box">
          <Search size={18} />
          <input
            aria-label="搜索材料"
            placeholder="搜索书册、试卷或主题"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button aria-label="清空搜索" onClick={() => setSearch("")}>
              <X size={16} />
            </button>
          )}
        </label>
        <label className="filter-select">
          <SlidersHorizontal size={16} />
          <select
            aria-label="练习状态"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">全部状态</option>
            <option value="new">尚未完成</option>
            <option value="done">已完成</option>
          </select>
        </label>
      </div>
      {collections.length > 1 && (
        <div className="collection-filter">
          <button
            className={collection === "全部" ? "selected" : ""}
            onClick={() => setCollection("全部")}
          >
            全部
          </button>
          {collections.length <= 24 ? (
            collections.map((c) => (
              <button
                key={c}
                className={collection === c ? "selected" : ""}
                onClick={() => setCollection(c)}
              >
                {c}
              </button>
            ))
          ) : (
            <select
              aria-label="选择资料集"
              value={collection}
              onChange={(e) => setCollection(e.target.value)}
            >
              <option>全部</option>
              {collections.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          )}
        </div>
      )}
      <div className="list-caption">
        <span>{collection === "全部" ? "练习材料" : collection}</span>
        <span>{filtered.length} 份</span>
      </div>
      {!filtered.length ? (
        <div className="empty">
          <BookOpen size={35} />
          <h2>{bookmarksOnly ? "还没有收藏材料" : "没有找到匹配的材料"}</h2>
          <p>
            {bookmarksOnly
              ? "打开材料后，点击右上角的收藏按钮。"
              : "试试其他关键词或资料分类。"}
          </p>
        </div>
      ) : (
        <div className="material-list">
          {filtered.slice(0, visible).map((i) => {
            const Icon = kinds.find((k) => k.id === i.kind)?.icon || BookOpen;
            return (
              <div className="material-row" key={i.id}>
                <span className={"material-icon " + i.kind}>
                  <Icon size={21} />
                </span>
                <button
                  className="material-main"
                  onClick={() => navigate("/item/" + encodeURIComponent(i.id))}
                >
                  <strong>{i.title}</strong>
                  <span>
                    {i.collection}
                    {i.count ? " · " + i.count + " 项" : ""}
                    {completed.has(i.id) && (
                      <span className="completed-label">
                        <CheckCircle2 size={13} />
                        已练习
                      </span>
                    )}
                  </span>
                  <MaterialLabels item={i} />
                </button>
                <button
                  className={
                    "icon-button bookmark-toggle " +
                    (progress.bookmarks.includes(i.id) ? "selected" : "")
                  }
                  aria-label={
                    progress.bookmarks.includes(i.id)
                      ? "取消收藏 " + i.title
                      : "收藏 " + i.title
                  }
                  onClick={() => toggleBookmark(i.id)}
                >
                  <Bookmark
                    size={18}
                    fill={
                      progress.bookmarks.includes(i.id)
                        ? "currentColor"
                        : "none"
                    }
                  />
                </button>
                <button
                  className="row-start"
                  onClick={() => navigate("/item/" + encodeURIComponent(i.id))}
                >
                  开始练习
                  <ChevronRight size={16} />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {filtered.length > visible && (
        <div className="load-more">
          <button
            className="button secondary"
            onClick={() => setVisible((v) => v + 60)}
          >
            再显示 60 份
          </button>
        </div>
      )}
    </>
  );
}

function HistoryView({ mistakes }: { mistakes: boolean }) {
  const p = useProgress();
  const items = p.attempts.filter(
    (a) => !mistakes || (a.total != null && (a.score || 0) < a.total),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{mistakes ? "错题复习" : "练习记录"}</h1>
          <p>
            {mistakes
              ? "回到做错的练习，结合解析和原文再练一遍。"
              : "每一次交卷、听写和完成练习，都保存在这里。"}
          </p>
        </div>
        <button
          className="button secondary"
          onClick={() => downloadJSON("ielts-lab-progress.json", p)}
        >
          <Download size={16} />
          导出记录
        </button>
      </div>
      {!items.length ? (
        <div className="empty">
          <CheckCircle2 size={38} />
          <h2>{mistakes ? "暂时没有错题记录" : "开始练习，留下第一条记录"}</h2>
          <p>
            {mistakes
              ? "提交客观题练习后，需要复习的材料会出现在这里。"
              : "在资料库选择材料，完成后即可在这里回顾。"}
          </p>
          <button
            className="button"
            onClick={() => navigate("/library/listening")}
          >
            去练习
          </button>
        </div>
      ) : (
        <div className="history-list">
          {items.map((a) => (
            <div className="history-row" key={a.id}>
              <span className="history-date">{date(a.createdAt)}</span>
              <div className="history-info">
                <strong>{a.title}</strong>
                <span>
                  {label(a.kind)}
                  {a.durationSeconds
                    ? " · " +
                      Math.max(1, Math.round(a.durationSeconds / 60)) +
                      " 分钟"
                    : ""}
                  {a.detail ? " · " + a.detail : ""}
                </span>
              </div>
              <span
                className={
                  "score-badge " +
                  (a.total && a.score === a.total ? "perfect" : "")
                }
              >
                {a.total != null ? `${a.score || 0} / ${a.total}` : "已记录"}
              </span>
              <button
                className="button secondary"
                onClick={() =>
                  navigate(
                    "/item/" +
                      encodeURIComponent(a.itemId) +
                      "?review=" +
                      encodeURIComponent(a.id),
                  )
                }
              >
                再练一次
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function SettingsView({ library }: { library: Library }) {
  const [status, setStatus] = useState("");
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>资料与设置</h1>
          <p>管理个人资料库，保留自己的学习记录。</p>
        </div>
      </div>
      <section className="settings-section">
        <h2>当前资料库</h2>
        <div className="settings-line">
          <span>材料来源</span>
          <strong>
            {library.mode === "archive"
              ? "本地个人归档 + 原创练习"
              : "应用自带的原创示例"}
          </strong>
        </div>
        <div className="settings-line">
          <span>可练习材料</span>
          <strong>{library.items.length} 份</strong>
        </div>
        <div className="settings-line">
          <span>保存位置</span>
          <strong>当前电脑</strong>
        </div>
        <p className="muted">
          音频、题目与学习记录由本地服务读取。Git 仓库只包含应用代码和原创示例。
        </p>
        {library.mode === "demo" && (
          <details>
            <summary>连接已有的本地归档</summary>
            <p>在项目目录执行下面的命令，再重新启动应用：</p>
            <pre>npm run import -- /你的归档目录{`\n`}npm run dev</pre>
            <p className="muted">
              选择包含 data/整理 和 data/media 的归档根目录。
            </p>
          </details>
        )}
      </section>
      <section className="settings-section">
        <h2>学习记录备份</h2>
        <p>
          导出后可保存到自己的备份位置。导入会替换本机当前的练习记录、草稿、收藏和笔记。
        </p>
        <div className="button-group">
          <button
            className="button secondary"
            onClick={() =>
              downloadJSON("ielts-lab-progress.json", getProgress())
            }
          >
            <Download size={16} />
            导出全部记录
          </button>
          <label className="button secondary file-picker">
            导入记录
            <input
              type="file"
              accept="application/json,.json"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                try {
                  if (f.size > 5 * 1024 * 1024)
                    throw new Error("记录文件超过 5 MB，请选择较小的有效备份");
                  const v = JSON.parse(await f.text());
                  if (
                    !window.confirm(
                      "用这份备份替换当前学习记录？建议先导出现有记录。",
                    )
                  )
                    return;
                  importProgress(v);
                  setStatus("学习记录已导入");
                } catch (err) {
                  setStatus((err as Error).message);
                }
                e.target.value = "";
              }}
            />
          </label>
        </div>
        {status && <p role="status">{status}</p>}
      </section>
      <section className="settings-section">
        <h2>功能范围</h2>
        <p>
          支持本地听力、精听、阅读、词句听写、口语录音、写作、打字和公开课学习。
        </p>
        <p className="muted">
          口语和写作目前保存你的练习，不提供 AI
          分数。原平台的真人服务、会员权益和新内容更新需在原服务中使用。
        </p>
        {!!library.issues?.length && (
          <details>
            <summary>资料缺失说明（{library.issues.length} 项）</summary>
            <ul>
              {library.issues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </>
  );
}
