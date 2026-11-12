import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { QuestionRow } from "../lib/questions.mjs";
import { dictationDiff } from "../lib/dictation-diff.mjs";
import type { DailyLesson } from "../lib/daily";
import type { StudyItem } from "../types";
import { mediaUrl, RichText, MarkdownText } from "../lib/content";
import { assessRow, displayAnswer } from "../lib/questions.mjs";
import { listeningSegments } from "../lib/listening-segments.mjs";
import {
  ChevronLeft,
  ChevronRight,
  EyeOff,
  Languages,
  Pause,
  PenLine,
  Play,
  Repeat,
  RotateCcw,
  SkipBack,
  SkipForward,
  Star,
  X,
} from "lucide-react";

const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

type ListeningProps = {
  itemId: string;
  lesson: DailyLesson;
  disabled: boolean;
  send: (action: string, body: Record<string, unknown>) => Promise<boolean>;
};
export default function DailyListening({
  itemId,
  lesson,
  disabled,
  send,
}: ListeningProps) {
  const [item, setItem] = useState<StudyItem | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setItem(null);
    setError("");
    void fetch(`/api/items/${encodeURIComponent(itemId)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error("听力材料加载失败，请重新打开分段听。");
        return response.json();
      })
      .then(setItem)
      .catch((reason) => {
        if (reason.name !== "AbortError") setError(reason.message);
      });
    return () => controller.abort();
  }, [itemId]);
  if (error) return <p role="alert">{error}</p>;
  if (!item) return <p role="status">正在加载听力材料…</p>;
  return (
    <SegmentPlayer
      key={item.id}
      item={item}
      lesson={lesson}
      disabled={disabled}
      send={send}
    />
  );
}

function SegmentPlayer({
  item,
  lesson,
  disabled,
  send,
}: { item: StudyItem } & Omit<ListeningProps, "itemId">) {
  const audio = useRef<HTMLAudioElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const repeatTimer = useRef<number | undefined>(undefined);
  const [gap, setGap] = useState(0);
  const [duration, setDuration] = useState(Number(item.data.seconds) || 0);
  const [index, setIndex] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  const [sentence, setSentence] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [range, setRange] = useState<{ start: number; end?: number } | null>(
    null,
  );
  const [loop, setLoop] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [translation, setTranslation] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>(() => {
    try {
      const value = JSON.parse(
        localStorage.getItem(`ielts-listening:${item.id}`) || "{}",
      );
      return value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string",
            ),
          )
        : {};
    } catch {
      return {};
    }
  });
  const [saveStatus, setSaveStatus] = useState("笔记保存在此浏览器");
  const { segments, error: segmentError } = useMemo(
    () => listeningSegments(item.data, duration),
    [item.data, duration],
  );
  const segment = segments[index];
  const src = mediaUrl(item, item.data.audioUrl);
  const lines = segment?.lines ?? [];
  const activeLine = sentence === null ? null : lines[sentence];
  const segmentEnd = segment?.end ?? (duration || undefined);
  const scopeStart = activeLine?.start ?? segment?.start ?? 0;
  const scopeEnd = activeLine
    ? Math.min(activeLine.end, segmentEnd ?? activeLine.end)
    : segmentEnd;
  const start = range?.start ?? scopeStart;
  const end = range?.end ?? scopeEnd;
  /** The line under the playhead, used for highlighting and sentence stepping. */
  const playhead = lines.findIndex(
    (line) => currentTime >= line.start && currentTime < line.end,
  );
  const hasTranslation = lines.some((line) => line.translation);
  const noteKey = `segment-${segment?.start}`;
  function persist(next: Record<string, string>) {
    setNotes(next);
    try {
      localStorage.setItem(`ielts-listening:${item.id}`, JSON.stringify(next));
      setSaveStatus("已保存在此浏览器");
    } catch {
      setSaveStatus("保存失败，请复制笔记后再离开页面");
    }
  }
  function saveNote(value: string, key = noteKey) {
    persist({ ...notes, [key]: value });
  }
  function seek(time: number) {
    if (audio.current) audio.current.currentTime = time;
    setCurrentTime(time);
  }
  function pause() {
    window.clearTimeout(repeatTimer.current);
    audio.current?.pause();
  }
  /** Turning looping off also cancels a repeat already waiting out the gap. */
  function toggleLoop() {
    if (loop) window.clearTimeout(repeatTimer.current);
    setLoop(!loop);
  }
  function repeat() {
    pause();
    if (audio.current) audio.current.currentTime = start;
    repeatTimer.current = window.setTimeout(() => void play(true), gap * 1000);
  }
  function stopAtEnd() {
    const player = audio.current;
    if (player && end !== undefined && player.currentTime >= end) {
      if (loop) repeat();
      else {
        player.pause();
        player.currentTime = end;
      }
    }
  }
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(stopAtEnd, 25);
    return () => window.clearInterval(timer);
  }, [playing, segment, end, start, loop, gap]);
  useEffect(() => {
    const player = audio.current;
    return () => {
      window.clearTimeout(repeatTimer.current);
      player?.pause();
    };
  }, []);
  // Follow the playhead inside the transcript list without moving the page.
  useEffect(() => {
    const container = list.current;
    if (!playing || !container || playhead < 0) return;
    const row = container.children[playhead] as HTMLElement | undefined;
    if (!row) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (
      top < container.scrollTop ||
      bottom > container.scrollTop + container.clientHeight
    )
      container.scrollTo({ top: Math.max(0, top - 24), behavior: "smooth" });
  }, [playhead, playing]);
  async function play(restart: boolean, from = start) {
    window.clearTimeout(repeatTimer.current);
    const player = audio.current;
    if (!player || !segment) return;
    setError("");
    if (
      restart ||
      player.currentTime < start ||
      (end !== undefined && player.currentTime >= end)
    )
      player.currentTime = from;
    player.playbackRate = speed;
    try {
      await player.play();
    } catch {
      setError("播放未能启动，请重试。");
    }
  }
  function select(next: number) {
    pause();
    setRange(null);
    setIndex(next);
    setSentence(null);
    setExpanded(null);
    setError("");
    seek(segments[next].start);
  }
  function chooseSentence(next: number, autoplay = true) {
    pause();
    setRange(null);
    setSentence(next);
    setExpanded(next);
    seek(lines[next].start);
    if (autoplay) void play(true, lines[next].start);
  }
  function wholeSegment() {
    pause();
    setSentence(null);
    setExpanded(null);
    setRange(null);
    seek(segment.start);
  }
  /** Step from the chosen sentence, or from the playhead when the whole segment is in scope. */
  const base = sentence ?? playhead;
  const canPrevious = base > 0;
  const canNext = base < lines.length - 1;
  function step(delta: number) {
    const next = Math.min(
      lines.length - 1,
      Math.max(0, (base < 0 ? (delta > 0 ? -1 : 0) : base) + delta),
    );
    chooseSentence(next);
  }
  function abRepeat() {
    const time = audio.current?.currentTime ?? currentTime;
    if (!range) setRange({ start: Math.max(scopeStart, time) });
    else if (range.end === undefined && time > range.start + 0.2) {
      setRange({ start: range.start, end: time });
      setLoop(true);
    }
  }
  useEffect(() => {
    // Read the element itself: React's `playing` can lag a media event behind.
    const toggle = () =>
      audio.current && !audio.current.paused ? pause() : void play(false);
    /** Space on a control inside the player means play/pause, not "click it". */
    const ownsSpace = (target: HTMLElement) =>
      !target.closest("input, textarea, select, [contenteditable]") &&
      (!target.closest("button, summary, a[href]") ||
        !!root.current?.contains(target));
    function shortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing
      )
        return;
      // Esc plays/pauses while typing a dictation, where Space must type a space.
      if (
        event.key === "Escape" &&
        target.closest(".listening-sentence-editor textarea")
      ) {
        event.preventDefault();
        toggle();
        return;
      }
      if (target.closest("input, textarea, select, [contenteditable]")) return;
      if (event.code === "Space") {
        if (!ownsSpace(target)) return;
        event.preventDefault();
        if (!event.repeat) toggle();
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "r") void play(true);
      if (key === "l") toggleLoop();
      if (event.key === "ArrowLeft" && canPrevious) {
        event.preventDefault();
        step(-1);
      }
      if (event.key === "ArrowRight" && canNext) {
        event.preventDefault();
        step(1);
      }
    }
    // Buttons activate on Space keyup; cancel it so the focused control is not clicked.
    function release(event: KeyboardEvent) {
      if (event.code === "Space" && ownsSpace(event.target as HTMLElement))
        event.preventDefault();
    }
    window.addEventListener("keydown", shortcut);
    window.addEventListener("keyup", release);
    return () => {
      window.removeEventListener("keydown", shortcut);
      window.removeEventListener("keyup", release);
    };
  });
  if (segmentError || !src)
    return (
      <p className="daily-empty">
        {segmentError || "这份材料没有可播放的音频。"}
      </p>
    );
  const numbers = (part: (typeof segments)[number]) =>
    part.entries
      .map(({ row }) =>
        row.number === row.endNumber
          ? `${row.number}`
          : `${row.number}–${row.endNumber}`,
      )
      .join("、");
  const total = Math.max(0.01, (end ?? duration) - start);
  const percent = (time: number) =>
    `${Math.min(100, Math.max(0, ((time - start) / total) * 100))}%`;
  const scopeName = sentence === null ? "本段" : "本句";
  return (
    <div className="daily-listening" ref={root}>
      <nav className="listening-segment-nav" aria-label="听力段落">
        <h2>第 {numbers(segment)} 题</h2>
        <button
          className="listening-icon"
          aria-label="上一段"
          title="上一段"
          disabled={index === 0}
          onClick={() => select(index - 1)}
        >
          <ChevronLeft size={16} />
        </button>
        <ol className="listening-segment-list">
          {segments.map((part, i) => (
            <li key={i}>
              <button
                aria-label={`第 ${numbers(part)} 题`}
                aria-current={i === index ? "step" : undefined}
                onClick={() => i !== index && select(i)}
              >
                {numbers(part)}
              </button>
            </li>
          ))}
        </ol>
        <button
          className="listening-icon"
          aria-label="下一段"
          title="下一段"
          disabled={index === segments.length - 1}
          onClick={() => select(index + 1)}
        >
          <ChevronRight size={16} />
        </button>
        <p className="listening-segment-meta">
          第 {index + 1} / {segments.length} 段 · {clock(segment.start)}–
          {segment.end === null ? "结束" : clock(segment.end)}
        </p>
      </nav>
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        onLoadedMetadata={(event) => {
          if (Number.isFinite(event.currentTarget.duration))
            setDuration(event.currentTarget.duration);
        }}
        onTimeUpdate={(event) => {
          setCurrentTime(event.currentTarget.currentTime);
          stopAtEnd();
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          if (loop) repeat();
        }}
        onError={() => {
          setPlaying(false);
          setError("音频加载失败，请重新打开分段听。");
        }}
      />
      <div className="listening-player" aria-label="播放控制" role="group">
        <div className="listening-transport">
          <button
            className="listening-icon"
            aria-label="上一句"
            title="上一句（←）"
            disabled={!canPrevious}
            onClick={() => step(-1)}
          >
            <SkipBack size={16} />
          </button>
          <button
            className="listening-play"
            aria-label={playing ? "暂停" : `播放${scopeName}`}
            title="播放 / 暂停（空格）"
            onClick={() => (playing ? pause() : void play(false))}
          >
            {playing ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <button
            className="listening-icon"
            aria-label="下一句"
            title="下一句（→）"
            disabled={!canNext}
            onClick={() => step(1)}
          >
            <SkipForward size={16} />
          </button>
          <button
            className="listening-icon"
            aria-label={`重听${scopeName}`}
            title={`从头重听${scopeName}（R）`}
            onClick={() => void play(true)}
          >
            <RotateCcw size={16} />
          </button>
        </div>
        <div className="listening-seek">
          <div className="listening-track">
            {range && (
              <span
                className="listening-track-range"
                style={{
                  left: percent(range.start),
                  right:
                    range.end === undefined
                      ? "0%"
                      : `calc(100% - ${percent(range.end)})`,
                }}
              />
            )}
            {sentence === null &&
              !range &&
              lines
                .filter((line) => line.start > start)
                .map((line) => (
                  <span
                    key={line.start}
                    className="listening-track-tick"
                    style={{ left: percent(line.start) }}
                  />
                ))}
            <input
              type="range"
              aria-label="播放进度"
              min={start}
              max={end ?? duration}
              step="0.01"
              value={Math.min(end ?? duration, Math.max(start, currentTime))}
              onChange={(event) => seek(Number(event.target.value))}
            />
          </div>
          <span className="listening-time">
            {clock(currentTime)} / {clock(end ?? duration)}
          </span>
        </div>
        <div className="listening-options">
          <div
            className="listening-segmented"
            role="radiogroup"
            aria-label="播放范围"
          >
            <button
              role="radio"
              aria-checked={sentence === null}
              onClick={() => sentence !== null && wholeSegment()}
            >
              整段
            </button>
            <button
              role="radio"
              aria-checked={sentence !== null}
              title="只播放当前句；也可直接点原文中的句子"
              onClick={() =>
                sentence === null &&
                chooseSentence(Math.max(0, playhead), false)
              }
            >
              单句
            </button>
          </div>
          <button
            className="listening-toggle"
            aria-pressed={loop}
            title="循环播放当前范围（L）"
            onClick={toggleLoop}
          >
            <Repeat size={15} />
            循环
          </button>
          {loop && (
            <label className="listening-inline-select">
              间隔
              <select
                aria-label="循环间隔"
                value={gap}
                onChange={(event) => setGap(Number(event.target.value))}
              >
                {[0, 1, 2, 3].map((seconds) => (
                  <option key={seconds} value={seconds}>
                    {seconds} 秒
                  </option>
                ))}
              </select>
            </label>
          )}
          {range?.end === undefined ? (
            <span className="listening-ab">
              <button
                className="listening-toggle"
                aria-pressed={!!range}
                title={
                  range
                    ? "播放到想结束的位置后点击，设为复读终点 B"
                    : "在当前播放位置设复读起点 A"
                }
                disabled={!!range && currentTime <= range.start + 0.2}
                onClick={abRepeat}
              >
                {range ? `A ${clock(range.start)} · 设 B 点` : "A-B 复读"}
              </button>
              {range && (
                <button
                  className="listening-icon"
                  aria-label="清除复读区间"
                  title="清除复读区间"
                  onClick={() => setRange(null)}
                >
                  <X size={14} />
                </button>
              )}
            </span>
          ) : (
            <span className="listening-ab is-set">
              A-B {clock(range.start)}–{clock(range.end)}
              <button
                className="listening-icon"
                aria-label="清除复读区间"
                title="清除复读区间"
                onClick={() => setRange(null)}
              >
                <X size={14} />
              </button>
            </span>
          )}
          <label className="listening-inline-select">
            语速
            <select
              aria-label="分段听语速"
              value={speed}
              onChange={(event) => {
                const value = Number(event.target.value);
                setSpeed(value);
                if (audio.current) audio.current.playbackRate = value;
              }}
            >
              {[0.75, 0.85, 1, 1.25].map((value) => (
                <option key={value} value={value}>
                  {value}×
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="listening-workbench">
        <section className="daily-listening-transcript" aria-label="本段原文">
          <div className="listening-transcript-header">
            <h3>本段原文</h3>
            <button
              className="listening-toggle"
              aria-pressed={hidden}
              title="盲听：隐藏原文，只保留句子序号"
              onClick={() => setHidden(!hidden)}
            >
              <EyeOff size={15} />
              隐藏原文
            </button>
            {hasTranslation && (
              <button
                className="listening-toggle"
                aria-pressed={translation}
                disabled={hidden}
                onClick={() => setTranslation(!translation)}
              >
                <Languages size={15} />
                显示译文
              </button>
            )}
          </div>
          <ol className="listening-sentences" ref={list}>
            {lines.map((line, i) => {
              const dictation = notes[`dictation-${line.start}`] || "";
              const marked = notes[`mark-${line.start}`] === "yes";
              return (
                <li
                  key={line.start}
                  className={[
                    sentence === i ? "is-selected" : "",
                    playing && playhead === i ? "is-current" : "",
                  ].join(" ")}
                >
                  <div className="listening-line">
                    <button
                      className="listening-line-play"
                      aria-label={`播放第 ${i + 1} 句`}
                      aria-pressed={sentence === i}
                      onClick={(event) => {
                        const selection = window.getSelection();
                        if (
                          event.detail > 0 &&
                          selection &&
                          !selection.isCollapsed &&
                          selection.rangeCount > 0 &&
                          selection
                            .getRangeAt(0)
                            .intersectsNode(event.currentTarget)
                        )
                          return;
                        chooseSentence(i);
                      }}
                    >
                      <span className="listening-timestamp">
                        {clock(line.start)}
                      </span>
                      <span className="listening-line-text">
                        {hidden ? (
                          <span className="listening-line-hidden">
                            第 {i + 1} 句
                          </span>
                        ) : (
                          line.text
                        )}
                        {!hidden && translation && line.translation && (
                          <small>{line.translation}</small>
                        )}
                      </span>
                    </button>
                    <span className="listening-line-tools">
                      {dictation && expanded !== i && (
                        <span
                          className="listening-badge"
                          title={`我的听写：${dictation}`}
                        >
                          已听写
                        </span>
                      )}
                      <button
                        className="listening-line-tool listening-dictate"
                        aria-label={`听写第 ${i + 1} 句`}
                        aria-expanded={expanded === i}
                        title={expanded === i ? "收起听写" : "听写这一句"}
                        onClick={() => {
                          if (expanded === i) return setExpanded(null);
                          if (sentence !== i) {
                            pause();
                            setRange(null);
                            setSentence(i);
                            seek(line.start);
                          }
                          setExpanded(i);
                          requestAnimationFrame(() =>
                            document
                              .getElementById(
                                `sentence-${line.start}-dictation`,
                              )
                              ?.focus(),
                          );
                        }}
                      >
                        <PenLine size={15} />
                      </button>
                      <button
                        className="listening-line-tool listening-mark"
                        aria-label={`第 ${i + 1} 句还需练`}
                        aria-pressed={marked}
                        title={marked ? "取消“还需练”标记" : "标记为还需练"}
                        onClick={() =>
                          persist({
                            ...notes,
                            [`mark-${line.start}`]: marked ? "" : "yes",
                          })
                        }
                      >
                        <Star size={15} />
                      </button>
                    </span>
                  </div>
                  {expanded === i && (
                    <SentencePractice
                      line={line}
                      number={i + 1}
                      text={dictation}
                      checked={notes[`checked-${line.start}`] || ""}
                      checks={(lesson.dictationChecks || []).filter(
                        (entry) =>
                          entry.start === line.start &&
                          entry.reference === line.text,
                      )}
                      disabled={disabled}
                      saveStatus={saveStatus}
                      available={lesson.capabilities?.runtime !== false}
                      save={(key, value) => saveNote(value, key)}
                      check={(text) =>
                        send("dictation", { start: line.start, text })
                      }
                    />
                  )}
                </li>
              );
            })}
          </ol>
          <p className="listening-shortcuts">
            点句子单句播放 · 空格 播放/暂停（听写框内用 Esc）· R 重听 · ← → 切句
            · L 循环
          </p>
        </section>
        <section className="listening-practice" aria-label="听写与题目">
          <details className="listening-questions" open>
            <summary>本段题目</summary>
            <div key={index}>
              {segment.entries.map(({ row, group }) => (
                <article key={row.id}>
                  <RichText html={group.title} />
                  {mediaUrl(item, group.image) && (
                    <img
                      className="daily-listening-diagram"
                      src={mediaUrl(item, group.image)}
                      alt="题目图示"
                    />
                  )}
                  {mediaUrl(item, group.optionsImage) && (
                    <img
                      className="daily-listening-diagram"
                      src={mediaUrl(item, group.optionsImage)}
                      alt="匹配选项图"
                    />
                  )}
                  <RichText html={group.content} />
                  <RichText html={row.content} />
                  {row.options.length > 0 && (
                    <ListeningChoices
                      row={row}
                      value={notes[`answer-${row.id}`]}
                      onChange={(value) => saveNote(value, `answer-${row.id}`)}
                    />
                  )}
                  <details className="listening-answer">
                    <summary>查看第 {row.number} 题答案</summary>
                    {row.options.length > 0 && (
                      <ListeningAnswerCheck
                        row={row}
                        value={notes[`answer-${row.id}`]}
                      />
                    )}
                    <p>正确答案：{displayAnswer(row)}</p>
                  </details>
                </article>
              ))}
            </div>
          </details>
          <details className="listening-segment-notes">
            <summary>整段笔记</summary>
            <label htmlFor="listening-note">本段笔记</label>
            <textarea
              id="listening-note"
              value={typeof notes[noteKey] === "string" ? notes[noteKey] : ""}
              onChange={(event) => saveNote(event.target.value)}
              placeholder="记录整段理解…"
            />
            {lines.some((line) => notes[String(line.start)]) && (
              <details className="listening-legacy-notes">
                <summary>以往句子笔记</summary>
                {lines
                  .filter((line) => notes[String(line.start)])
                  .map((line) => (
                    <p key={line.start}>
                      {clock(line.start)}　{notes[String(line.start)]}
                    </p>
                  ))}
              </details>
            )}
            <p role="status" className="listening-save-status">
              {saveStatus}
            </p>
          </details>
        </section>
      </div>
    </div>
  );
}

function selectedChoices(value?: string): string[] {
  try {
    const saved = JSON.parse(value || "[]");
    if (Array.isArray(saved))
      return saved.filter((option) => typeof option === "string");
  } catch {
    /* A damaged local answer can be selected again. */
  }
  return [];
}

function ListeningAnswerCheck({
  row,
  value,
}: {
  row: QuestionRow;
  value?: string;
}) {
  const selected = selectedChoices(value);
  const result = assessRow(row, row.type === "2" ? selected : selected[0]);
  const labels: Record<string, string> = {
    correct: "回答正确",
    incorrect: "回答错误",
    partial: `部分正确（${result.earned}/${result.total}）`,
    blank: "尚未作答",
    manual: "需人工核对",
  };
  return (
    <div className="listening-answer-check" role="status">
      <p className={`daily-${result.status}`}>{labels[result.status]}</p>
      {result.reason && <p>{result.reason}</p>}
      <p>
        你的答案：{selected.length ? displayAnswer(row, selected) : "未选择"}
      </p>
    </div>
  );
}

function ListeningChoices({
  row,
  value,
  onChange,
}: {
  row: QuestionRow;
  value?: string;
  onChange: (value: string) => void;
}) {
  const selected = selectedChoices(value);
  const multiple = row.type === "2";
  return (
    <fieldset className="listening-choices">
      <legend>
        {multiple
          ? `选择 ${row.weight} 项 · 已选 ${selected.length} 项`
          : "选择一项"}
      </legend>
      {row.options.map((option) => {
        const checked = selected.includes(option.value);
        return (
          <label
            className={`listening-option ${checked ? "is-selected" : ""}`}
            key={option.value}
          >
            <input
              type={multiple ? "checkbox" : "radio"}
              name={`listening-${row.id}`}
              checked={checked}
              disabled={multiple && !checked && selected.length >= row.weight}
              onChange={() =>
                onChange(
                  JSON.stringify(
                    multiple
                      ? checked
                        ? selected.filter((value) => value !== option.value)
                        : [...selected, option.value]
                      : [option.value],
                  ),
                )
              }
            />
            <span>{option.label}.</span>
            <RichText html={option.content} />
          </label>
        );
      })}
    </fieldset>
  );
}

function SentencePractice({
  line,
  number,
  text,
  checked,
  checks,
  disabled,
  available,
  saveStatus,
  save,
  check,
}: {
  line: { start: number; text: string };
  number: number;
  text: string;
  checked: string;
  checks: NonNullable<DailyLesson["dictationChecks"]>;
  disabled: boolean;
  available: boolean;
  saveStatus: string;
  save: (key: string, value: string) => void;
  check: (text: string) => Promise<boolean>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  let snapshot: { text: string; reference: string } | null = null;
  try {
    snapshot = JSON.parse(checked || "null");
  } catch {
    /* Keep legacy notes readable. */
  }
  const comparison =
    snapshot?.reference === line.text ? snapshot.text : checks.at(-1)?.text;
  const parts =
    typeof comparison === "string" && comparison.trim()
      ? dictationDiff(line.text, comparison)
      : null;
  const perfect = !!parts?.every((part) => part.type === "equal");
  /** The newest hint for exactly the compared text; older ones are history. */
  const current = [...checks]
    .reverse()
    .find((entry) => entry.text === comparison);
  const history = checks
    .filter((entry) => entry !== current && entry.feedback)
    .reverse();
  const pending = submitting || current?.status === "pending";
  const id = `sentence-${line.start}`;
  async function requestHint(value: string) {
    if (!value.trim() || submitting || disabled || !available) return;
    setSubmitting(true);
    setError("");
    try {
      if (!(await check(value))) setError("重听提示提交失败，可以重试。");
    } catch {
      setError("AI 暂不可用，可以重试重听提示。");
    } finally {
      setSubmitting(false);
    }
  }
  /** Checking is local; a hint is requested once per differing dictation text. */
  function verify() {
    if (!text.trim()) return;
    setError("");
    save(
      `checked-${line.start}`,
      JSON.stringify({ text, reference: line.text }),
    );
    const differs = dictationDiff(line.text, text).some(
      (part) => part.type !== "equal",
    );
    const known = checks.some(
      (entry) => entry.text === text && entry.status !== "failed",
    );
    if (differs && !known) void requestHint(text);
  }
  const feedbackText = (entry: (typeof checks)[number]) =>
    entry.feedback
      ? `${entry.feedback.feedback_zh} ${entry.feedback.practice_zh}`
      : "";
  return (
    <div className="listening-sentence-editor">
      <div className="listening-editor-head">
        <label htmlFor={`${id}-dictation`}>听写第 {number} 句</label>
        <small>Esc 播放 / 暂停</small>
      </div>
      <textarea
        id={`${id}-dictation`}
        aria-label={`第 ${number} 句听写`}
        maxLength={6000}
        value={text}
        onChange={(event) =>
          save(`dictation-${line.start}`, event.target.value)
        }
        placeholder="写下听到的内容…"
      />
      <div className="listening-check-actions">
        <button
          className="listening-primary"
          disabled={!text.trim()}
          onClick={verify}
        >
          核对听写
        </button>
        {comparison !== undefined && comparison !== text && parts && (
          <small>听写已修改，下方为上次核对</small>
        )}
      </div>
      {parts && (
        <div className="listening-result">
          <p
            className="listening-diff"
            aria-label={`第 ${number} 句原文对照`}
            title="绿色为漏词，删除线为多写或替换"
          >
            <span className="listening-result-label">对照</span>
            {parts.map((part, index) =>
              part.type === "missing" ? (
                <ins key={index}>{part.text} </ins>
              ) : part.type === "extra" ? (
                <del key={index}>{part.text} </del>
              ) : (
                <span key={index}>{part.text} </span>
              ),
            )}
          </p>
          {perfect ? (
            <p className="listening-perfect">✓ 全部正确</p>
          ) : (
            <div
              className="listening-hint"
              aria-label={`第 ${number} 句重听提示`}
              aria-live="polite"
            >
              <span className="listening-result-label">提示</span>
              <div className="listening-hint-body">
                {current?.feedback ? (
                  <FeedbackNote text={feedbackText(current)} />
                ) : pending ? (
                  <span role="status">正在生成重听提示…</span>
                ) : !available ? (
                  <span>AI 服务尚未配置，文字对照可以继续使用。</span>
                ) : (
                  <span>
                    {current?.status === "failed"
                      ? "提示生成失败。"
                      : "暂无重听提示。"}
                    <button
                      className="listening-link"
                      disabled={disabled || comparison !== text}
                      title={
                        comparison !== text
                          ? "请先核对当前听写"
                          : disabled
                            ? "课程正在处理其他任务，稍后再试"
                            : undefined
                      }
                      onClick={() => void requestHint(text)}
                    >
                      {current?.status === "failed" ? "重试" : "获取提示"}
                    </button>
                  </span>
                )}
                {history.length > 0 && (
                  <details className="listening-hint-history">
                    <summary>历史提示（{history.length}）</summary>
                    {history.map((entry) => (
                      <article key={entry.id}>
                        <p>听写　{entry.text}</p>
                        <FeedbackNote text={feedbackText(entry)} />
                      </article>
                    ))}
                  </details>
                )}
              </div>
            </div>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {saveStatus.startsWith("保存失败") && (
        <small role="alert" className="listening-save-status">
          {saveStatus}
        </small>
      )}
    </div>
  );
}

function FeedbackNote({ text }: { text: string }) {
  const body = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  // Offer "expand" only when the clamped text is actually cut off. Re-measure
  // whenever the box resizes: a note inside a closed <details> measures 0 until
  // it is opened, and wrapping changes with the panel width.
  useLayoutEffect(() => {
    const node = body.current;
    if (!node || expanded) return;
    const measure = () =>
      setOverflows(node.scrollHeight > node.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text, expanded]);
  return (
    <div className="listening-feedback">
      <div ref={body} className={expanded ? "" : "listening-feedback-summary"}>
        <MarkdownText text={text} />
      </div>
      {(overflows || expanded) && (
        <button
          className="listening-link"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "收起反馈" : "展开完整反馈"}
        </button>
      )}
    </div>
  );
}
