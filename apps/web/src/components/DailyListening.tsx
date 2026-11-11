import { useEffect, useMemo, useRef, useState } from "react";
import type { QuestionRow } from "../lib/questions.mjs";
import { dictationDiff } from "../lib/dictation-diff.mjs";
import type { DailyLesson } from "../lib/daily";
import type { StudyItem } from "../types";
import { mediaUrl, RichText, MarkdownText } from "../lib/content";
import { displayAnswer } from "../lib/questions.mjs";
import { listeningSegments } from "../lib/listening-segments.mjs";

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
  const activeLine = sentence === null ? null : segment?.lines[sentence];
  const start = range?.start ?? activeLine?.start ?? segment?.start ?? 0;
  const end =
    range?.end ??
    (activeLine
      ? Math.min(activeLine.end, segment.end ?? (duration || activeLine.end))
      : segment?.end);
  const noteKey = `segment-${segment?.start}`;
  function saveNote(value: string, key = noteKey) {
    const next = { ...notes, [key]: value };
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
    setExpanded(null);
    setCurrentTime(segments[next].start);
    setError("");
    if (audio.current) audio.current.currentTime = segments[next].start;
  }
  function chooseSentence(next: number) {
    pause();
    setRange(null);
    setSentence(next);
    setExpanded(next);
    setCurrentTime(segment.lines[next].start);
    void play(true, segment.lines[next].start);
  }
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        target.closest("input, textarea, select, [contenteditable]")
      )
        return;
      if (event.code === "Space") {
        if (target.closest("button, summary, a[href]")) return;
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
      <div className="daily-listening-nav listening-segment-nav">
        <h2>第 {label} 题</h2>
        <button disabled={index === 0} onClick={() => select(index - 1)}>
          上一段
        </button>
        <label>
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
        <p className="listening-segment-meta">
          {clock(segment.start)} →{" "}
          {segment.end === null ? "音频结束" : clock(segment.end)} · 第{" "}
          {index + 1} / {segments.length} 段
        </p>
      </div>
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
        <details className="listening-range">
          <summary>播放设置</summary>
          <p className="listening-settings-heading">局部循环</p>
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
          <p className="listening-shortcuts">
            空格播放 / 暂停 · R 重听 · ← → 切句
          </p>{" "}
        </details>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="listening-workbench">
        <section className="daily-listening-transcript" aria-label="本段原文">
          <div className="listening-transcript-header">
            <h3>本段原文</h3>
            <button
              onClick={() => {
                pause();
                setSentence(null);
                setExpanded(null);
                setRange(null);
                setCurrentTime(segment.start);
                if (audio.current) audio.current.currentTime = segment.start;
              }}
            >
              回到整段
            </button>
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
                <SentencePractice
                  line={line}
                  number={i + 1}
                  expanded={expanded === i}
                  showReference={!hidden}
                  text={notes[`dictation-${line.start}`] || ""}
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
                  collapse={() => setExpanded(null)}
                />
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
                  <details>
                    <summary>查看第 {row.number} 题答案</summary>
                    <p>{displayAnswer(row)}</p>
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
            {segment.lines.some((line) => notes[String(line.start)]) && (
              <details className="listening-legacy-notes">
                <summary>以往句子笔记</summary>
                {segment.lines
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

function ListeningChoices({
  row,
  value,
  onChange,
}: {
  row: QuestionRow;
  value?: string;
  onChange: (value: string) => void;
}) {
  let selected: string[] = [];
  try {
    const saved = JSON.parse(value || "[]");
    if (Array.isArray(saved))
      selected = saved.filter((option) => typeof option === "string");
  } catch {
    /* A damaged local answer can be selected again. */
  }
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
  expanded,
  showReference,
  text,
  checked,
  checks,
  disabled,
  available,
  saveStatus,
  save,
  check,
  collapse,
}: {
  line: { start: number; text: string };
  number: number;
  expanded: boolean;
  showReference: boolean;
  text: string;
  checked: string;
  checks: NonNullable<DailyLesson["dictationChecks"]>;
  disabled: boolean;
  available: boolean;
  saveStatus: string;
  save: (key: string, value: string) => void;
  check: (text: string) => Promise<boolean>;
  collapse: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [hintOpen, setHintOpen] = useState(false);
  useEffect(() => {
    if (!expanded) setHintOpen(false);
  }, [expanded]);
  const [error, setError] = useState("");
  let snapshot: { text: string; reference: string } | null = null;
  try {
    snapshot = JSON.parse(checked || "null");
  } catch {
    /* Keep legacy notes readable. */
  }
  const latest = checks.at(-1);
  const comparison =
    snapshot?.reference === line.text ? snapshot.text : latest?.text;
  const id = `sentence-${line.start}`;
  function verify() {
    if (!text.trim()) return;
    setError("");
    setHintOpen(false);
    save(
      `checked-${line.start}`,
      JSON.stringify({ text, reference: line.text }),
    );
  }
  async function requestHint() {
    if (!text.trim() || submitting || disabled || comparison !== text) return;
    if (!available) {
      setError("AI 服务尚未配置，文字对照可以继续使用。");
      return;
    }
    setSubmitting(true);
    setHintOpen(true);
    setError("");
    try {
      if (!(await check(text))) setError("重听提示提交失败，可以重试。");
    } catch {
      setError("AI 暂不可用，可以重试重听提示。");
    } finally {
      setSubmitting(false);
    }
  }
  if (!expanded)
    return (
      <div className="listening-sentence-preview">
        {text && <p>我的听写　{text}</p>}
        {latest?.feedback && <small>已有重听提示</small>}
        {!text && !latest && <p>点击句子开始听写</p>}
      </div>
    );
  return (
    <div className="listening-sentence-editor">
      <label htmlFor={`${id}-dictation`}>我的听写</label>
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
        <button disabled={!text.trim()} onClick={verify}>
          核对听写
        </button>
        <button
          disabled={
            !text.trim() || comparison !== text || disabled || submitting
          }
          onClick={() => void requestHint()}
        >
          {submitting || latest?.status === "pending"
            ? "正在生成提示…"
            : "给我重听提示"}
        </button>
        <button onClick={collapse}>收起本句</button>
      </div>
      {showReference && typeof comparison === "string" && comparison.trim() && (
        <div className="listening-diff" aria-label={`第 ${number} 句原文对照`}>
          <p>
            原文对照 <small>绿色为漏词，删除线为多写或替换</small>
          </p>
          {comparison !== text && (
            <small>当前听写已修改，下面是上次核对。</small>
          )}
          <div>
            {dictationDiff(line.text, comparison).map((part, index) =>
              part.type === "missing" ? (
                <ins key={index}>{part.text} </ins>
              ) : part.type === "extra" ? (
                <del key={index}>{part.text} </del>
              ) : (
                <span key={index}>{part.text} </span>
              ),
            )}
          </div>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {checks.length > 0 && (
        <details
          className="listening-ai-notes"
          aria-label={`第 ${number} 句重听提示`}
          open={hintOpen}
          onToggle={(event) => setHintOpen(event.currentTarget.open)}
        >
          <summary>重听提示</summary>
          {latest?.text !== text && <small>这条提示对应上次提交的听写。</small>}
          {latest?.status === "failed" && (
            <p role="alert">重听提示生成失败，可以再次请求。</p>
          )}
          {latest?.feedback ? (
            <FeedbackNote
              text={`${latest.feedback.feedback_zh}\n\n${latest.feedback.practice_zh}`}
            />
          ) : (
            <p role="status">
              {latest?.status === "pending"
                ? "正在生成重听提示…"
                : "本次提示尚未生成。"}
            </p>
          )}
          {checks.length > 1 && (
            <details>
              <summary>历史提示（{checks.length - 1}）</summary>
              {checks
                .slice(0, -1)
                .reverse()
                .map((entry) => (
                  <article key={entry.id}>
                    <p>听写　{entry.text}</p>
                    {entry.feedback ? (
                      <FeedbackNote
                        text={`${entry.feedback.feedback_zh}\n\n${entry.feedback.practice_zh}`}
                      />
                    ) : (
                      <p>
                        {entry.status === "failed" ? "生成失败" : "尚未生成"}
                      </p>
                    )}
                  </article>
                ))}
            </details>
          )}
        </details>
      )}
      <small role="status" className="listening-save-status">
        {saveStatus}
      </small>
    </div>
  );
}

function FeedbackNote({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const lengthy = text.length > 160 || text.split("\n").length > 3;
  return (
    <div className="listening-feedback">
      <div className={lengthy && !expanded ? "listening-feedback-summary" : ""}>
        <MarkdownText text={text} />
      </div>
      {lengthy && (
        <button aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? "收起反馈" : "展开完整反馈"}
        </button>
      )}
    </div>
  );
}
