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
  const [duration, setDuration] = useState(Number(item.data.seconds) || 0);
  const [index, setIndex] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  const { segments, error: segmentError } = useMemo(
    () => listeningSegments(item.data, duration),
    [item.data, duration],
  );
  const segment = segments[index];
  const src = mediaUrl(item, item.data.audioUrl);
  function stopAtEnd() {
    const player = audio.current;
    if (
      player &&
      segment?.end !== null &&
      segment?.end !== undefined &&
      player.currentTime >= segment.end
    ) {
      player.pause();
      player.currentTime = segment.end;
    }
  }
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(stopAtEnd, 25);
    return () => window.clearInterval(timer);
  }, [playing, segment]);
  useEffect(() => {
    const player = audio.current;
    return () => player?.pause();
  }, []);
  async function play(restart: boolean) {
    const player = audio.current;
    if (!player || !segment) return;
    setError("");
    if (
      restart ||
      player.currentTime < segment.start ||
      (segment.end !== null && player.currentTime >= segment.end)
    )
      player.currentTime = segment.start;
    player.playbackRate = speed;
    try {
      await player.play();
    } catch {
      setError("播放未能启动，请重试。");
    }
  }
  function select(next: number) {
    audio.current?.pause();
    setPlaying(false);
    setIndex(next);
    setError("");
    if (audio.current) audio.current.currentTime = segments[next].start;
  }
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
      <p>
        按原听力题的答案定位分段，从音频开头连续听到结尾。分界精确到答案所在句的起点，同一句的题目共用一段。
      </p>
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
        onTimeUpdate={stopAtEnd}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => {
          setPlaying(false);
          setError("音频加载失败，请重新打开分段听。");
        }}
      />
      <div className="daily-listening-nav">
        <button
          onClick={() => (playing ? audio.current?.pause() : void play(false))}
        >
          {playing ? "暂停" : "播放本段"}
        </button>
        <button onClick={() => void play(true)}>重听本段</button>
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
      {error && <p role="alert">{error}</p>}
      <div key={index}>
        {segment.entries.map(({ row, group }) => (
          <article key={row.id}>
            <RichText html={group.title} />
            <RichText html={group.content} />
            <RichText html={row.content} />
            {row.options.map((option) => (
              <div key={option.value}>
                {option.label}. <RichText html={option.content} />
              </div>
            ))}
            <details>
              <summary>查看第 {row.number} 题答案</summary>
              <p>{displayAnswer(row)}</p>
            </details>
          </article>
        ))}
        <details className="daily-listening-transcript">
          <summary>查看本段原文</summary>
          {segment.lines.map((line, i) => (
            <p key={i}>{line.text}</p>
          ))}
        </details>
      </div>
    </div>
  );
}
