import { useEffect, useMemo, useRef, useState } from "react";
import type { StudyItem } from "../types";
import { mediaUrl, RichText } from "../lib/content";
import { displayAnswer } from "../lib/questions.mjs";
import { listeningSegments } from "../lib/listening-segments.mjs";

const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export default function DailyListening({ itemId }: { itemId: string }) {
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
  return <SegmentPlayer key={item.id} item={item} />;
}

function SegmentPlayer({ item }: { item: StudyItem }) {
  const audio = useRef<HTMLAudioElement>(null);
  const repeatTimer = useRef<number | undefined>(undefined);
  const [gap, setGap] = useState(0);
  const [duration, setDuration] = useState(Number(item.data.seconds) || 0);
  const [index, setIndex] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  const [sentence, setSentence] = useState<number | null>(null);
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
        ? value
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
  const activeLine = sentence === null ? null : segment?.lines[sentence];
  const start = range?.start ?? activeLine?.start ?? segment?.start ?? 0;
  const end =
    range?.end ??
    (activeLine
      ? Math.min(activeLine.end, segment.end ?? (duration || activeLine.end))
      : segment?.end);
  const noteKey = activeLine
    ? String(activeLine.start)
    : `segment-${segment?.start}`;
  function saveNote(value: string) {
    const next = { ...notes, [noteKey]: value };
    setNotes(next);
    try {
      localStorage.setItem(`ielts-listening:${item.id}`, JSON.stringify(next));
      setSaveStatus("已保存在此浏览器");
    } catch {
      setSaveStatus("保存失败，请复制笔记后再离开页面");
    }
  }
  function pause() {
    window.clearTimeout(repeatTimer.current);
    audio.current?.pause();
  }
  function repeat() {
    pause();
    if (audio.current) audio.current.currentTime = start;
    repeatTimer.current = window.setTimeout(() => void play(true), gap * 1000);
  }
  function stopAtEnd() {
    const player = audio.current;
    if (
      player &&
      end !== null &&
      end !== undefined &&
      player.currentTime >= end
    ) {
      if (loop) {
        repeat();
      } else {
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
  async function play(restart: boolean, from = start) {
    window.clearTimeout(repeatTimer.current);
    const player = audio.current;
    if (!player || !segment) return;
    setError("");
    if (
      restart ||
      player.currentTime < start ||
      (end != null && player.currentTime >= end)
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
    setPlaying(false);
    setRange(null);
    setIndex(next);
    setSentence(null);
    setCurrentTime(segments[next].start);
    setError("");
    if (audio.current) audio.current.currentTime = segments[next].start;
  }
  function chooseSentence(next: number) {
    pause();
    setRange(null);
    setSentence(next);
    setCurrentTime(segment.lines[next].start);
    void play(true, segment.lines[next].start);
  }
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, select, button, [contenteditable]"))
        return;
      if (event.code === "Space") {
        event.preventDefault();
        if (playing) pause();
        else void play(false);
      }
      if (event.key.toLowerCase() === "r") void play(true);
      if (event.key === "ArrowLeft" && sentence !== null && sentence > 0) {
        event.preventDefault();
        chooseSentence(sentence - 1);
      }
      if (
        event.key === "ArrowRight" &&
        sentence !== null &&
        sentence < segment.lines.length - 1
      ) {
        event.preventDefault();
        chooseSentence(sentence + 1);
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  });
  if (segmentError || !src)
    return (
      <p className="daily-empty">
        {segmentError || "这份材料没有可播放的音频。"}
      </p>
    );
  const label = segment.entries
    .map(({ row }) =>
      row.number === row.endNumber
        ? `${row.number}`
        : `${row.number}–${row.endNumber}`,
    )
    .join("、");
  return (
    <div className="daily-listening">
      <div className="daily-listening-nav">
        <button disabled={index === 0} onClick={() => select(index - 1)}>
          上一段
        </button>
        <label>
          选择题目{" "}
          <select
            aria-label="选择听力段落"
            value={index}
            onChange={(event) => select(Number(event.target.value))}
          >
            {segments.map((part, i) => (
              <option key={i} value={i}>
                第{" "}
                {part.entries
                  .map(({ row }) =>
                    row.number === row.endNumber
                      ? row.number
                      : `${row.number}–${row.endNumber}`,
                  )
                  .join("、")}{" "}
                题
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={index === segments.length - 1}
          onClick={() => select(index + 1)}
        >
          下一段
        </button>
      </div>
      <h2>第 {label} 题</h2>
      <p>
        {clock(segment.start)} →{" "}
        {segment.end === null ? "音频结束" : clock(segment.end)} · 第{" "}
        {index + 1} / {segments.length} 段
      </p>
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
      <div className="listening-player">
        <label className="listening-seek">
          播放进度
          <input
            type="range"
            min={start}
            max={end ?? duration}
            step="0.01"
            value={Math.min(end ?? duration, Math.max(start, currentTime))}
            onChange={(event) => {
              const time = Number(event.target.value);
              if (audio.current) audio.current.currentTime = time;
              setCurrentTime(time);
            }}
          />
          <span>
            {clock(currentTime)} / {clock(end ?? duration)}
          </span>
        </label>
        <div className="daily-listening-nav">
          <button onClick={() => (playing ? pause() : void play(false))}>
            {playing ? "暂停" : sentence === null ? "播放本段" : "播放当前句"}
          </button>
          <button onClick={() => void play(true)}>
            {sentence === null ? "重听本段" : "重听当前句"}
          </button>
          <button
            disabled={sentence === null || sentence === 0}
            onClick={() => chooseSentence(sentence! - 1)}
          >
            上一句
          </button>
          <button
            disabled={sentence === null || sentence >= segment.lines.length - 1}
            onClick={() => chooseSentence(sentence! + 1)}
          >
            下一句
          </button>
          <label>
            <input
              type="checkbox"
              checked={loop}
              onChange={(event) => {
                pause();
                setLoop(event.target.checked);
              }}
            />
            循环播放
          </label>
          <label>
            循环间隔
            <select
              aria-label="循环间隔"
              value={gap}
              onChange={(event) => {
                pause();
                setGap(Number(event.target.value));
              }}
            >
              {[0, 1, 2, 3].map((seconds) => (
                <option key={seconds} value={seconds}>
                  {seconds} 秒
                </option>
              ))}
            </select>
          </label>
          <label>
            语速{" "}
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
        <details className="listening-range">
          <summary>局部循环</summary>
          <div className="daily-listening-nav">
            <button
              onClick={() =>
                setRange({ start: audio.current?.currentTime ?? start })
              }
            >
              设为循环起点
            </button>
            <button
              disabled={!range || currentTime <= range.start}
              onClick={() => {
                setRange({ start: range!.start, end: currentTime });
                setLoop(true);
              }}
            >
              设为循环终点
            </button>
            {range && (
              <button onClick={() => setRange(null)}>清除循环范围</button>
            )}
            {range && (
              <span>
                {clock(range.start)} 至{" "}
                {range.end === undefined ? "待设置终点" : clock(range.end)}
              </span>
            )}
          </div>
        </details>
        <p className="listening-shortcuts">
          空格播放 / 暂停 · R 重听 · ← → 切句
        </p>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="listening-workbench">
        <section className="daily-listening-transcript" aria-label="本段原文">
          <div className="listening-transcript-header">
            <h3>本段原文</h3>
            <button onClick={() => setHidden(!hidden)}>
              {hidden ? "显示原文" : "隐藏原文"}
            </button>
            <label>
              <input
                type="checkbox"
                checked={translation}
                onChange={(event) => setTranslation(event.target.checked)}
              />
              译文
            </label>
          </div>
          <button
            onClick={() => {
              pause();
              setSentence(null);
              setRange(null);
              setCurrentTime(segment.start);
              if (audio.current) audio.current.currentTime = segment.start;
            }}
          >
            回到整段
          </button>
          <ol className="listening-sentences">
            {segment.lines.map((line, i) => (
              <li
                key={line.start}
                className={
                  sentence === i ||
                  (playing &&
                    currentTime >= line.start &&
                    currentTime < line.end)
                    ? "is-current"
                    : ""
                }
              >
                <button
                  aria-label={`播放第 ${i + 1} 句`}
                  aria-pressed={sentence === i}
                  onClick={() => chooseSentence(i)}
                >
                  <span className="listening-timestamp">
                    {clock(line.start)}
                  </span>
                  <span>
                    {hidden ? `第 ${i + 1} 句 · 点击播放` : line.text}
                    {!hidden && translation && line.translation && (
                      <small>{line.translation}</small>
                    )}
                  </span>
                </button>
                <button
                  className="listening-mark"
                  aria-pressed={notes[`mark-${line.start}`] === "yes"}
                  onClick={() => {
                    const next = {
                      ...notes,
                      [`mark-${line.start}`]:
                        notes[`mark-${line.start}`] === "yes" ? "" : "yes",
                    };
                    setNotes(next);
                    try {
                      localStorage.setItem(
                        `ielts-listening:${item.id}`,
                        JSON.stringify(next),
                      );
                    } catch {
                      setSaveStatus("保存失败，请复制笔记后再离开页面");
                    }
                  }}
                >
                  {notes[`mark-${line.start}`] === "yes"
                    ? "已标记 · 还需练"
                    : "标记还需练"}
                </button>
              </li>
            ))}
          </ol>
        </section>
        <section className="listening-practice" aria-label="听写与题目">
          <label className="listening-note-label" htmlFor="listening-note">
            {sentence === null ? "本段笔记" : `第 ${sentence + 1} 句听写与笔记`}
          </label>
          <textarea
            id="listening-note"
            value={typeof notes[noteKey] === "string" ? notes[noteKey] : ""}
            onChange={(event) => saveNote(event.target.value)}
            placeholder="写下听到的内容、没听懂的词或自己的理解…"
          />
          <p role="status" className="listening-save-status">
            {saveStatus}
          </p>
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
                  {row.options.map((option) => (
                    <div className="listening-option" key={option.value}>
                      {option.label}. <RichText html={option.content} />
                    </div>
                  ))}
                  <details>
                    <summary>查看第 {row.number} 题答案</summary>
                    <p>{displayAnswer(row)}</p>
                  </details>
                </article>
              ))}
            </div>
          </details>
        </section>
      </div>
    </div>
  );
}
