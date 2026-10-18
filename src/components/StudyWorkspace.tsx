import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Mic,
  Pause,
  Play,
  RotateCcw,
  Square,
  Volume2,
} from "lucide-react";
import type { Attempt, StudyItem } from "../types";
import { RichText, mediaUrl, textOf } from "../lib/content";
import { getProgress, recordAttempt, saveDraft } from "../lib/progress";
import {
  checkDictation,
  countWords,
  formatTime,
  typingMetrics,
  reviewIndex,
  writingReview,
} from "../lib/study.mjs";
import "../study.css";

type Row = Record<string, any>;
function rows(data: any, keys = ["items", "sentences"]): Row[] {
  if (Array.isArray(data)) return data;
  for (const key of keys) if (Array.isArray(data?.[key])) return data[key];
  return data && typeof data === "object" ? [data] : [];
}
function useClock(initial = 0) {
  const [seconds, setSeconds] = useState(initial);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setSeconds((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return { seconds, setSeconds, running, setRunning };
}
function downloadText(name: string, value: string) {
  const url = URL.createObjectURL(
    new Blob([value], { type: "text/plain;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name.replace(/[\\/:*?"<>|]/g, "-");
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Pager({
  index,
  count,
  onChange,
  disabled = false,
  jumpable = false,
}: {
  index: number;
  count: number;
  onChange: (n: number) => void;
  disabled?: boolean;
  jumpable?: boolean;
}) {
  const [position, setPosition] = useState(String(index + 1));
  useEffect(() => setPosition(String(index + 1)), [index]);
  function jump() {
    const n = Number(position);
    if (position.trim() && Number.isInteger(n) && n >= 1 && n <= count) {
      if (n - 1 !== index) onChange(n - 1);
    } else setPosition(String(index + 1));
  }
  return (
    <nav className="study-pager" aria-label="练习翻页">
      <button
        onClick={() => onChange(index - 1)}
        disabled={disabled || index <= 0}
        aria-label="上一条"
      >
        <ChevronLeft size={18} />
      </button>
      <span>
        {jumpable && count ? (
          <input
            className="study-page-jump"
            aria-label="跳转到第几条"
            type="number"
            min={1}
            max={count}
            value={position}
            disabled={disabled}
            onChange={(e) => setPosition(e.target.value)}
            onBlur={jump}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                jump();
              }
            }}
          />
        ) : count ? (
          index + 1
        ) : (
          0
        )}{" "}
        / {count}
      </span>
      <button
        onClick={() => onChange(index + 1)}
        disabled={disabled || index >= count - 1}
        aria-label="下一条"
      >
        <ChevronRight size={18} />
      </button>
    </nav>
  );
}
function Empty({
  children = "这份材料中没有可用的练习内容。",
}: {
  children?: React.ReactNode;
}) {
  return (
    <div className="study-empty">
      <BookOpen size={28} />
      <p>{children}</p>
    </div>
  );
}
function Audio({
  item,
  source,
  label = "原声播放",
}: {
  item: StudyItem;
  source?: string;
  label?: string;
}) {
  const url = mediaUrl(item, source);
  const ref = useRef<HTMLAudioElement>(null);
  const [rate, setRate] = useState("1");
  const [loop, setLoop] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (ref.current) ref.current.playbackRate = Number(rate);
  }, [url, rate]);
  if (!url)
    return <span className="study-muted">这条材料没有已保存的音频</span>;
  return (
    <div className="study-audio">
      <span className="study-audio-label">
        <Volume2 size={15} /> {label}
      </span>
      <audio
        ref={ref}
        key={url}
        controls
        preload="none"
        src={url}
        loop={loop}
        onError={() => setFailed(true)}
      />
      <div className="study-audio-options">
        <label>
          倍速{" "}
          <select
            aria-label="播放速度"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
          >
            {["0.75", "1", "1.25", "1.5", "2"].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={loop}
            onChange={(e) => setLoop(e.target.checked)}
          />{" "}
          单条循环
        </label>
      </div>
      {failed && (
        <span role="alert">音频加载失败，请检查归档文件是否还在原位置。</span>
      )}
    </div>
  );
}
function audioOptions(row: Row): [string, string][] {
  if (row.audioUrls)
    return Object.entries(row.audioUrls)
      .filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      )
      .map(([key, url]) => [
        key === "bf_emma" ? "英音" : key === "af_heart" ? "美音" : key,
        url,
      ]);
  if (Array.isArray(row.questionOralList))
    return row.questionOralList.map((a: Row) => [
      String(a.typeStr || "题目原声"),
      a.oralUrl,
    ]);
  return row.audioUrl ? [["原声", row.audioUrl]] : [];
}
function Voices({ item, row }: { item: StudyItem; row: Row }) {
  const options = audioOptions(row);
  const [selected, setSelected] = useState(0);
  const choice = options[selected] || options[0];
  return (
    <div className="study-voices">
      {options.length > 1 && (
        <div className="study-segments" role="group" aria-label="发音选择">
          {options.map(([label], index) => (
            <button
              key={index}
              className={selected === index ? "is-active" : ""}
              onClick={() => setSelected(index)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <Audio item={item} source={choice?.[1]} />
    </div>
  );
}

function Writing({
  item,
  reviewAttempt,
}: {
  item: StudyItem;
  reviewAttempt?: Attempt;
}) {
  const review = writingReview(item.id, reviewAttempt);
  if (review && reviewAttempt) {
    const part = Number(item.data?.writingPart) === 1 ? 1 : 2;
    const recordedDate = new Date(reviewAttempt.createdAt);
    const recordedAt = Number.isFinite(recordedDate.getTime())
      ? recordedDate.toLocaleString("zh-CN")
      : "";
    const timingLabel = review.sharedTiming ? "整卷写作共用时间" : "本次用时";
    const duration =
      review.durationSeconds === null
        ? "未记录"
        : formatTime(review.durationSeconds);
    return (
      <div className="study-writing">
        <section className="study-panel study-writing-prompt">
          <div className="study-eyebrow">WRITING TASK {part} · 历史复习</div>
          <h2>{item.title}</h2>
          <RichText
            html={
              item.data?.writingQuestion ||
              item.data?.writingQuestionText ||
              item.data?.prompt ||
              ""
            }
          />
        </section>
        <section className="study-panel study-composer">
          <p className="study-review-notice">
            历史作答 · 只读{recordedAt ? ` · ${recordedAt}` : ""}
          </p>
          <div className="study-toolbar">
            <div>
              <strong>{review.words}</strong> 词
            </div>
            <span className="study-clock">
              {timingLabel} {duration}
            </span>
          </div>
          <label className="study-sr-only" htmlFor="writing-history-answer">
            该次提交的作文
          </label>
          <textarea
            id="writing-history-answer"
            className="study-essay"
            readOnly
            value={review.text}
            placeholder="该次未填写作文"
            spellCheck={false}
          />
          <h3>该次笔记</h3>
          <p className="study-history-notes">
            {review.notes || "该次没有保存笔记。"}
          </p>
          <div className="study-toolbar study-toolbar-bottom">
            <span className="study-muted">未进行自动评分</span>
            <button
              onClick={() =>
                downloadText(
                  `${item.title}-${reviewAttempt.id}.txt`,
                  `${item.title}\n${recordedAt}\n${timingLabel} ${duration} · ${review.words} 词\n\n作文\n${review.text}\n\n笔记\n${review.notes}`,
                )
              }
            >
              <Download size={16} /> 导出本次作答
            </button>
          </div>
        </section>
      </div>
    );
  }
  return <WritingPractice item={item} />;
}

function WritingPractice({ item }: { item: StudyItem }) {
  const draft = getProgress().drafts[item.id] || {};
  const [value, setValue] = useState(String(draft.text || ""));
  const [saved, setSaved] = useState(false);
  const timer = useClock(Number(draft.seconds) || 0);
  const words = countWords(value);
  const part = Number(item.data?.writingPart || 2);
  const trackLabel =
    item.testTrack === "general"
      ? "General Training · G 类"
      : item.testTrack === "academic"
        ? "Academic · A 类"
        : item.testTrack === "shared"
          ? "A / G 通用"
          : "类别待确认";
  const taskLabel =
    part === 2
      ? "议论文写作"
      : item.testTrack === "general"
        ? "书信写作"
        : item.testTrack === "academic"
          ? "图表 / 图示描述"
          : "Task 1 写作";
  const minWords = part === 1 ? 150 : 250;
  const targetSeconds = (part === 1 ? 20 : 40) * 60;
  const timeBucket = Math.floor(timer.seconds / 5);
  useEffect(() => {
    saveDraft(item.id, { text: value, seconds: timer.seconds });
    setSaved(true);
  }, [item.id, value, timeBucket]);
  return (
    <div className="study-writing">
      <section className="study-panel study-writing-prompt">
        <div className="study-eyebrow">
          {trackLabel} · WRITING TASK {part}
        </div>
        <h2>{taskLabel}</h2>
        {item.source === "original" && (
          <p className="study-original-label">原创练习材料</p>
        )}
        <RichText
          html={
            item.data?.writingQuestion ||
            item.data?.writingQuestionText ||
            item.data?.prompt ||
            ""
          }
        />
        <div className="study-hint">
          建议用时 {part === 1 ? 20 : 40} 分钟 · 至少 {minWords} 词
        </div>
      </section>
      <section className="study-panel study-composer">
        <div className="study-toolbar">
          <div>
            <strong>{words}</strong> 词{" "}
            <span className="study-muted">/ {minWords} 词</span>
          </div>
          <span
            className={
              timer.seconds > targetSeconds ? "study-warning" : "study-clock"
            }
          >
            {formatTime(timer.seconds)}
          </span>
          <button
            className="study-icon-button"
            onClick={() => timer.setRunning(!timer.running)}
            aria-label={timer.running ? "暂停计时" : "开始计时"}
          >
            {timer.running ? <Pause size={17} /> : <Play size={17} />}
          </button>
        </div>
        <label className="study-sr-only" htmlFor="writing-answer">
          你的作文
        </label>
        <textarea
          id="writing-answer"
          className="study-essay"
          placeholder="Write your response here…"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (!timer.running && timer.seconds === 0) timer.setRunning(true);
          }}
          spellCheck={false}
        />
        <div className="study-toolbar study-toolbar-bottom">
          <span className="study-muted" aria-live="polite">
            {saved ? "已自动保存" : "保存中…"}
          </span>
          <button
            onClick={() => downloadText(`${item.title}.txt`, value)}
            disabled={!value.trim()}
          >
            <Download size={16} /> 导出作文
          </button>
          <button
            className="primary"
            disabled={!value.trim()}
            onClick={() => {
              timer.setRunning(false);
              saveDraft(item.id, { text: value, seconds: timer.seconds });
              recordAttempt({
                itemId: item.id,
                title: item.title,
                kind: item.kind,
                durationSeconds: timer.seconds,
                answers: { essay: value },
                detail: `完成写作，${words} 词`,
              });
              setSaved(true);
            }}
          >
            保存本次练习
          </button>
        </div>
      </section>
    </div>
  );
}

function Speaking({ item }: { item: StudyItem }) {
  const questions = rows(item.data, [
    "oralQuestionDetailVOList",
    "questions",
    "items",
  ]);
  const [index, setIndex] = useState(0);
  const [recording, setRecording] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [recorded, setRecorded] = useState<{
    url: string;
    ext: string;
    question: number;
  } | null>(null);
  const [error, setError] = useState("");
  const [target, setTarget] = useState(120);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const blobUrlRef = useRef("");
  const mountedRef = useRef(true);
  const timer = useClock();
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (recorderRef.current?.state === "recording")
        recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    };
  }, []);
  async function startRecording() {
    setError("");
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      setError(
        "此浏览器暂不支持录音。请使用 localhost 或 HTTPS 地址，并允许麦克风权限。",
      );
      return;
    }
    setRequesting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find(
        (t) => MediaRecorder.isTypeSupported(t),
      );
      const recorder = new MediaRecorder(
        stream,
        type ? { mimeType: type } : undefined,
      );
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        if (!mountedRef.current) return;
        const mime = recorder.mimeType || "audio/webm";
        if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = URL.createObjectURL(
          new Blob(chunks, { type: mime }),
        );
        setRecorded({
          url: blobUrlRef.current,
          ext: mime.includes("mp4") ? "m4a" : "webm",
          question: index,
        });
        setRecording(false);
        timer.setRunning(false);
      };
      recorder.onerror = () => {
        setError("录音中断，请检查麦克风权限后重试。");
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        timer.setRunning(false);
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
      timer.setSeconds(0);
      timer.setRunning(true);
    } catch (err) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      setError(
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "麦克风权限未开启，请在浏览器地址栏中允许录音。"
          : "无法开启麦克风，请检查设备是否可用。",
      );
    } finally {
      if (mountedRef.current) setRequesting(false);
    }
  }
  function stopRecording() {
    if (recorderRef.current?.state !== "recording") return;
    recorderRef.current.stop();
    recordAttempt({
      itemId: item.id,
      title: item.title,
      kind: item.kind,
      durationSeconds: timer.seconds,
      detail: `口语第 ${index + 1} 题录音练习`,
    });
  }
  if (!questions.length) return <Empty />;
  const question = questions[index];
  return (
    <div className="study-speaking">
      <section className="study-panel">
        <div className="study-toolbar">
          <span className="study-eyebrow">
            SPEAKING · PART {question.oralPart || 1}
          </span>
          <Pager
            index={index}
            count={questions.length}
            disabled={recording || requesting}
            onChange={(n) => {
              if (!recording && !requesting) {
                setIndex(n);
                timer.setRunning(false);
                timer.setSeconds(0);
              }
            }}
          />
        </div>
        <div className="study-question">
          <RichText
            html={
              question.oralQuestion ||
              question.question ||
              question.prompt ||
              item.title
            }
          />
        </div>
        <Voices key={index} item={item} row={question} />
        <p className="study-muted">
          先听题，再用自己的表达回答。录音保留在当前页面，请及时下载。
        </p>
      </section>
      <section className="study-panel study-recording">
        <span className="study-eyebrow">YOUR RESPONSE</span>
        <div
          className={
            "study-recording-disc " + (recording ? "is-recording" : "")
          }
        >
          <Mic size={36} />
        </div>
        <div className="study-big-clock">{formatTime(timer.seconds)}</div>
        <div className="study-progress-track">
          <div
            style={{
              width: `${Math.min(100, (timer.seconds / target) * 100)}%`,
            }}
          />
        </div>
        <label className="study-muted">
          练习时长{" "}
          <select
            value={target}
            onChange={(e) => setTarget(Number(e.target.value))}
          >
            <option value={60}>1 分钟</option>
            <option value={120}>2 分钟</option>
            <option value={180}>3 分钟</option>
          </select>
        </label>
        {timer.seconds >= target && (
          <p className="study-warning" role="status">
            已到设定时长，可以结束回答。
          </p>
        )}
        <button
          className={recording ? "study-stop" : "primary"}
          disabled={requesting}
          onClick={recording ? stopRecording : startRecording}
        >
          {recording ? (
            <>
              <Square size={16} /> 结束录音
            </>
          ) : (
            <>
              <Mic size={16} /> {requesting ? "等待麦克风权限…" : "开始录音"}
            </>
          )}
        </button>
        {error && (
          <p className="study-warning" role="alert">
            {error}
          </p>
        )}
        {recorded && (
          <div className="study-recorded">
            <span>第 {recorded.question + 1} 题 · 我的录音</span>
            <audio controls src={recorded.url} />
            <a
              className="study-download"
              href={recorded.url}
              download={`${item.title}-${recorded.question + 1}.${recorded.ext}`}
            >
              <Download size={15} /> 下载录音
            </a>
          </div>
        )}
      </section>
    </div>
  );
}

function Vocabulary({
  item,
  reviewAttempt,
}: {
  item: StudyItem;
  reviewAttempt?: Attempt;
}) {
  const words = rows(item.data);
  const draft = getProgress().drafts[`study:${item.id}`] || {};
  const [index, setIndex] = useState(
    reviewIndex(words, reviewAttempt, item.kind, Number(draft.index) || 0),
  );
  const touched = useRef(false);
  const [statuses, setStatuses] = useState<
    Record<string, { known: boolean; due: string }>
  >(draft.statuses || {});
  const [mode, setMode] = useState("cards");
  const [reviewOnly, setReviewOnly] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const [answer, setAnswer] = useState("");
  const [checked, setChecked] = useState(false);
  const [filter, setFilter] = useState("");
  function wordId(row: Row) {
    return String(row.wordId || row.id || row.headWord || row.word);
  }
  const queue = words.filter(
    (row) =>
      (!reviewOnly ||
        (statuses[wordId(row)] &&
          (!statuses[wordId(row)].known ||
            Date.parse(statuses[wordId(row)].due) <= Date.now()))) &&
      (!filter ||
        String(row.headWord || row.word)
          .toLowerCase()
          .includes(filter.toLowerCase())),
  );
  const safeIndex = Math.min(index, Math.max(0, queue.length - 1));
  const row = queue[safeIndex];
  const headWord = row ? String(row.headWord || row.word || "") : "";
  const known = Object.values(statuses).filter((s) => s.known).length;
  useEffect(() => {
    if (!reviewAttempt || touched.current)
      saveDraft(`study:${item.id}`, { statuses, index });
  }, [statuses, index, item.id, reviewAttempt]);
  function move(n: number) {
    setIndex(n);
    setFlipped(false);
    setAnswer("");
    setChecked(false);
  }
  function mark(isKnown: boolean) {
    if (!row) return;
    touched.current = true;
    setStatuses((previous) => ({
      ...previous,
      [wordId(row)]: {
        known: isKnown,
        due: new Date(Date.now() + (isKnown ? 86400000 : 0)).toISOString(),
      },
    }));
    recordAttempt({
      itemId: item.id,
      title: item.title,
      kind: item.kind,
      score: isKnown ? 1 : 0,
      total: 1,
      answers: { [wordId(row)]: headWord },
      detail: `${headWord} · ${isKnown ? "已掌握" : "待复习"}`,
    });
    move(
      reviewOnly && isKnown
        ? safeIndex
        : Math.min(safeIndex + 1, queue.length - 1),
    );
  }
  return (
    <div className="study-word-workspace">
      <div className="study-toolbar study-vocab-tools">
        <div className="study-segments">
          <button
            className={mode === "cards" ? "is-active" : ""}
            onClick={() => {
              setMode("cards");
              setChecked(false);
            }}
          >
            单词卡片
          </button>
          <button
            className={mode === "dictation" ? "is-active" : ""}
            onClick={() => {
              setMode("dictation");
              setFlipped(false);
            }}
          >
            拼写听写
          </button>
        </div>
        <label>
          <input
            type="checkbox"
            checked={reviewOnly}
            onChange={(e) => {
              setReviewOnly(e.target.checked);
              move(0);
            }}
          />{" "}
          到期 / 生词复习
        </label>
        <input
          className="study-search"
          aria-label="查找单词"
          placeholder="查找单词…"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            move(0);
          }}
        />
      </div>
      <div className="study-vocab-progress">
        <span>
          已掌握 {known} / {words.length}
        </span>
        <div className="study-progress-track">
          <div
            style={{
              width: `${words.length ? (known / words.length) * 100 : 0}%`,
            }}
          />
        </div>
      </div>
      {!row ? (
        <Empty>
          {reviewOnly
            ? "当前没有到期或未掌握的单词。已掌握的词将在一天后进入复习。"
            : "没有找到匹配的单词。"}
        </Empty>
      ) : (
        <section className="study-panel study-word-card">
          <div className="study-toolbar">
            <span className="study-eyebrow">
              {mode === "cards" ? "VOCABULARY" : "SPELLING PRACTICE"}
            </span>
            <Pager
              index={safeIndex}
              count={queue.length}
              onChange={move}
              jumpable
            />
          </div>
          {mode === "cards" ? (
            <button
              className="study-flashcard"
              onClick={() => setFlipped(!flipped)}
              aria-expanded={flipped}
            >
              <span className="study-word">{headWord}</span>
              <span className="study-phonetic">
                {row.ukPhone ? `英 /${row.ukPhone}/` : ""}{" "}
                {row.usPhone ? `美 /${row.usPhone}/` : ""}
              </span>
              {!flipped && (
                <span className="study-muted">点击查看释义和例句</span>
              )}
            </button>
          ) : (
            <div className="study-dictation-form">
              <label htmlFor="word-answer">听录音，写出单词</label>
              <input
                id="word-answer"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder="Type the word…"
                value={answer}
                onChange={(e) => {
                  setAnswer(e.target.value);
                  setChecked(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && answer.trim()) {
                    setChecked(true);
                    setFlipped(true);
                  }
                }}
              />
              <button
                className="primary"
                disabled={!answer.trim()}
                onClick={() => {
                  setChecked(true);
                  setFlipped(true);
                }}
              >
                核对拼写
              </button>
              {checked && (
                <div
                  className={
                    checkDictation(answer, headWord)
                      ? "study-correct"
                      : "study-incorrect"
                  }
                  role="status"
                >
                  {checkDictation(answer, headWord)
                    ? "拼写正确"
                    : `正确拼写：${headWord}`}
                </div>
              )}
            </div>
          )}
          <Voices key={wordId(row)} item={item} row={row} />
          {flipped && (
            <div className="study-definition">
              {(Array.isArray(row.translations) ? row.translations : []).map(
                (translation: Row, n: number) => (
                  <p key={n}>
                    <span className="study-pos">{translation.pos}</span>{" "}
                    {translation.tranCn || translation.tranEn}
                  </p>
                ),
              )}
              {row.meaning && <p>{textOf(row.meaning)}</p>}
              {(Array.isArray(row.examples) ? row.examples : [])
                .slice(0, 5)
                .map((example: Row, n: number) => (
                  <blockquote key={n}>
                    <p>{example.en}</p>
                    <span>{example.cn}</span>
                  </blockquote>
                ))}
            </div>
          )}
          <div className="study-word-actions">
            <button onClick={() => mark(false)}>
              <RotateCcw size={17} /> 需要复习
            </button>
            <button className="primary" onClick={() => mark(true)}>
              <Check size={17} /> 已掌握
            </button>
          </div>
        </section>
      )}
      <p className="study-muted study-center">
        掌握标记和进度自动保存；已掌握的单词在一天后再次复习。
      </p>
    </div>
  );
}

function Dictation({
  item,
  reviewAttempt,
}: {
  item: StudyItem;
  reviewAttempt?: Attempt;
}) {
  const list = rows(item.data);
  const saved = getProgress().drafts[`study:${item.id}`] || {};
  const [index, setIndex] = useState(
    reviewIndex(list, reviewAttempt, item.kind, Number(saved.index) || 0),
  );
  const [answer, setAnswer] = useState(
    reviewAttempt ? "" : String(saved.answer || ""),
  );
  const [checked, setChecked] = useState(false);
  const [translation, setTranslation] = useState(false);
  const touched = useRef(false);
  const [results, setResults] = useState<Record<string, boolean>>(
    saved.results || {},
  );
  const started = useRef(Date.now());
  const row = list[index];
  const expected = row
    ? String(row.answerText || row.sentenceText || row.text || "")
    : "";
  const correct = checkDictation(answer, expected, item.kind);
  useEffect(() => {
    if (!reviewAttempt || touched.current)
      saveDraft(`study:${item.id}`, { index, answer, results });
  }, [index, answer, results, item.id, reviewAttempt]);
  function move(n: number) {
    setIndex(n);
    setAnswer("");
    setChecked(false);
    setTranslation(false);
    started.current = Date.now();
  }
  function check() {
    if (!answer.trim() || !expected) return;
    touched.current = true;
    setChecked(true);
    setResults((previous) => ({ ...previous, [index]: correct }));
    recordAttempt({
      itemId: item.id,
      title: item.title,
      kind: item.kind,
      score: correct ? 1 : 0,
      total: 1,
      durationSeconds: Math.round((Date.now() - started.current) / 1000),
      answers: { [row.sentenceId || row.id || index]: answer },
      detail: `第 ${index + 1} 条${correct ? "听写正确" : "需要复习"}`,
    });
  }
  if (!row) return <Empty />;
  return (
    <div className="study-dictation-workspace">
      <section className="study-panel">
        <div className="study-toolbar">
          <span className="study-eyebrow">
            {item.kind === "numbers"
              ? "NUMBER DICTATION"
              : "SENTENCE DICTATION"}
          </span>
          <Pager index={index} count={list.length} onChange={move} jumpable />
        </div>
        <h2>
          {item.kind === "numbers"
            ? row.category || "数字听写"
            : row.essayTitle || "听清每一个词"}
        </h2>
        <Voices key={index} item={item} row={row} />
        <form
          className="study-dictation-form"
          onSubmit={(e) => {
            e.preventDefault();
            check();
          }}
        >
          <label htmlFor="dictation-answer">
            输入你听到的{item.kind === "numbers" ? "数字或编号" : "句子"}
          </label>
          <textarea
            id="dictation-answer"
            rows={item.kind === "numbers" ? 2 : 4}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            value={answer}
            onChange={(e) => {
              touched.current = true;
              setAnswer(e.target.value);
              setChecked(false);
            }}
            placeholder="Listen, then type here…"
          />
          <div className="study-toolbar">
            <span className="study-muted">
              {item.kind === "numbers"
                ? "忽略空格、分组逗号和连字符；小数点参与核对"
                : "忽略大小写和句末标点，按完整句子核对"}
            </span>
            <button
              className="primary"
              type="submit"
              disabled={!answer.trim() || checked}
            >
              核对答案
            </button>
          </div>
        </form>
        {checked && (
          <div
            className={
              "study-answer-box " +
              (correct ? "study-correct" : "study-incorrect")
            }
            role="status"
          >
            <strong>{correct ? "听写正确" : "再留意一下这些表达"}</strong>
            <p>{expected}</p>
            {row.chinese && <p className="study-muted">{row.chinese}</p>}
            <button
              onClick={() => {
                setAnswer("");
                setChecked(false);
              }}
            >
              再听一遍
            </button>
          </div>
        )}
        {row.chinese && !checked && (
          <div className="study-translation">
            <button onClick={() => setTranslation(!translation)}>
              {translation ? "收起" : "查看"}中文提示
            </button>
            {translation && <p>{row.chinese}</p>}
          </div>
        )}
      </section>
      <div className="study-session-results">
        <span>
          本组已练 {Object.keys(results).length} / {list.length}
        </span>
        <span>正确 {Object.values(results).filter(Boolean).length} 条</span>
      </div>
    </div>
  );
}

function Grammar({ item }: { item: StudyItem }) {
  const list = rows(item.data, ["sentences", "items"]);
  const [index, setIndex] = useState(0);
  const [selectedWord, setSelectedWord] = useState<number | null>(null);
  const row = list[index];
  if (!row) return <Empty />;
  let tags = row.grammarTags || {};
  if (typeof tags === "string") {
    try {
      tags = JSON.parse(tags);
    } catch {
      tags = {};
    }
  }
  const words = Array.isArray(tags.words) ? tags.words : [];
  const structure = tags.clauseStructure || {};
  const selected = selectedWord == null ? null : words[selectedWord];
  const labels =
    structure.structure && typeof structure.structure === "object"
      ? Object.entries(structure.structure)
      : [];
  return (
    <div className="study-grammar-workspace">
      <section className="study-panel">
        <div className="study-toolbar">
          <span className="study-eyebrow">SENTENCE ANALYSIS</span>
          <Pager
            index={index}
            count={list.length}
            onChange={(n) => {
              setIndex(n);
              setSelectedWord(null);
            }}
          />
        </div>
        <h2 className="study-grammar-sentence">
          {row.sentenceText || row.text}
        </h2>
        <p className="study-translation-text">{row.chinese || tags.chinese}</p>
        <Voices key={index} item={item} row={row} />
        {words.length > 0 && (
          <>
            <h3>逐词解析</h3>
            <div className="study-grammar-tokens">
              {words.map((word: Row, n: number) => (
                <button
                  key={n}
                  onClick={() => setSelectedWord(selectedWord === n ? null : n)}
                  className={selectedWord === n ? "is-active" : ""}
                >
                  <strong>{word.word}</strong>
                  <span>{word.posLabel || word.pos}</span>
                </button>
              ))}
            </div>
            {selected && (
              <div className="study-word-detail">
                <strong>{selected.word}</strong>{" "}
                <span>{selected.phonetic}</span>
                <p>{selected.chinese}</p>
                <span className="study-pos">
                  {selected.posLabel || selected.pos}
                </span>
              </div>
            )}
          </>
        )}
        {labels.length > 0 && (
          <>
            <h3>句子结构</h3>
            <div className="study-structure">
              {labels.map(([label, value]) => (
                <div key={label}>
                  <span>{label}</span>
                  <p>
                    {Array.isArray(value)
                      ? value
                          .map((v) =>
                            typeof v === "string" ? v : JSON.stringify(v),
                          )
                          .join(" / ")
                      : typeof value === "string"
                        ? value
                        : JSON.stringify(value)}
                  </p>
                </div>
              ))}
            </div>
          </>
        )}
        {Array.isArray(structure.predicateGroups) &&
          structure.predicateGroups.length > 0 && (
            <>
              <h3>谓语结构</h3>
              <div className="study-tag-list">
                {structure.predicateGroups.map((group: Row, n: number) => (
                  <span key={n}>{group.text}</span>
                ))}
              </div>
            </>
          )}
        {!words.length && !labels.length && (
          <p className="study-muted">这条句子的归档中尚未提供结构分析。</p>
        )}
        <p className="study-muted study-footnote">
          展示材料中已保存的语法分析，可作为阅读辅助。
        </p>
      </section>
    </div>
  );
}

function Typing({ item }: { item: StudyItem }) {
  const sources = rows(item.data);
  const [index, setIndex] = useState(0);
  const [value, setValue] = useState("");
  const [finished, setFinished] = useState(false);
  const clock = useClock();
  const source = sources[index];
  const target = textOf(source?.content || source?.text || "");
  const metrics = typingMetrics(value, target, clock.seconds);
  function change(value: string) {
    setValue(value);
    if (!clock.running && !finished) clock.setRunning(true);
    if (value === target && target && !finished) {
      clock.setRunning(false);
      setFinished(true);
      const result = typingMetrics(value, target, Math.max(1, clock.seconds));
      recordAttempt({
        itemId: item.id,
        title: item.title,
        kind: item.kind,
        durationSeconds: clock.seconds,
        score: result.correct,
        total: Array.from(target).length,
        detail: `${result.wpm} WPM · ${result.accuracy}% 准确率`,
      });
    }
  }
  function reset(n = index) {
    setIndex(n);
    setValue("");
    setFinished(false);
    clock.setRunning(false);
    clock.setSeconds(0);
  }
  if (!target) return <Empty />;
  return (
    <div className="study-typing-workspace">
      <div className="study-metrics">
        <div>
          <strong>{metrics.wpm}</strong>
          <span>WPM</span>
        </div>
        <div>
          <strong>
            {metrics.accuracy}
            <small>%</small>
          </strong>
          <span>准确率</span>
        </div>
        <div>
          <strong>{formatTime(clock.seconds)}</strong>
          <span>用时</span>
        </div>
        <button onClick={() => reset()}>
          <RotateCcw size={16} /> 重新开始
        </button>
      </div>
      <section className="study-panel">
        <div className="study-toolbar">
          <span className="study-eyebrow">TYPING PRACTICE</span>
          {sources.length > 1 && (
            <Pager index={index} count={sources.length} onChange={reset} />
          )}
        </div>
        <h2>{source.title || item.title}</h2>
        <div className="study-typing-target" aria-label="练习原文">
          {Array.from(target).map((char, n) => (
            <span
              key={n}
              className={
                n < value.length
                  ? value[n] === char
                    ? "typed-correct"
                    : "typed-incorrect"
                  : n === value.length
                    ? "typing-cursor"
                    : ""
              }
            >
              {char}
            </span>
          ))}
        </div>
        <label className="study-sr-only" htmlFor="typing-answer">
          打字练习输入
        </label>
        <textarea
          id="typing-answer"
          className="study-typing-input"
          value={value}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          placeholder="开始输入，上方会逐字标注…"
          onChange={(e) => change(e.target.value)}
          readOnly={finished}
          onPaste={(e) => e.preventDefault()}
        />
        <div className="study-progress-track">
          <div style={{ width: `${metrics.progress}%` }} />
        </div>
        {finished && (
          <p className="study-correct" role="status">
            <Check size={18} /> 已完成，练习记录已保存。
          </p>
        )}
      </section>
    </div>
  );
}

function Courses({ item }: { item: StudyItem }) {
  const data = item.data || {};
  const attachments = Array.isArray(data.attachments) ? data.attachments : [];
  const media = attachments
    .map((a: Row) => ({ ...a, local: mediaUrl(item, a.url) }))
    .filter((a: Row) => a.local);
  const video = media.find(
    (a: Row) => a.kind?.includes("video") || /\.mp4(?:\?|$)/i.test(a.local),
  );
  const audio = media.find(
    (a: Row) =>
      a.kind?.includes("audio") ||
      /\.(?:mp3|mpga|m4a|wav)(?:\?|$)/i.test(a.local),
  );
  const slides = (Array.isArray(data.slidesMetadata) ? data.slidesMetadata : [])
    .flatMap((deck: Row) =>
      (Array.isArray(deck.page_list) ? deck.page_list : []).map(
        (page: Row, index: number) => ({
          url: mediaUrl(item, page.url),
          title: deck.name || "课件",
          number: index + 1,
        }),
      ),
    )
    .filter((page: Row) => page.url);
  const [index, setIndex] = useState(0);
  const [mode, setMode] = useState(video ? "video" : "audio");
  const [failed, setFailed] = useState(false);
  const player = useRef<HTMLVideoElement>(null);
  const [rate, setRate] = useState("1");
  const lastSave = useRef(0);
  const [position, setPosition] = useState(
    Number(getProgress().drafts[`course:${item.id}`]?.position) || 0,
  );
  function setPlaybackRate(value: string) {
    setRate(value);
    if (player.current) player.current.playbackRate = Number(value);
  }
  return (
    <div className="study-course-workspace">
      <section className="study-panel study-course-player">
        <div className="study-toolbar">
          <div className="study-segments">
            {video && (
              <button
                className={mode === "video" ? "is-active" : ""}
                onClick={() => {
                  setMode("video");
                  setFailed(false);
                }}
              >
                视频课堂
              </button>
            )}
            {audio && (
              <button
                className={mode === "audio" ? "is-active" : ""}
                onClick={() => setMode("audio")}
              >
                纯音频
              </button>
            )}
          </div>
          {Number(data.durationSeconds) > 0 && (
            <span className="study-muted">
              {Number(data.durationSeconds) < 60
                ? `${Math.round(Number(data.durationSeconds))} 秒`
                : `${Math.round(Number(data.durationSeconds) / 60)} 分钟`}
            </span>
          )}
        </div>
        {mode === "video" && video ? (
          <>
            <video
              ref={player}
              controls
              playsInline
              preload="metadata"
              src={video.local}
              onError={() => setFailed(true)}
              onLoadedMetadata={() => {
                if (player.current) {
                  if (position < player.current.duration)
                    player.current.currentTime = position;
                  player.current.playbackRate = Number(rate);
                }
              }}
              onTimeUpdate={(e) => {
                const current = e.currentTarget.currentTime;
                if (Math.abs(current - lastSave.current) > 5) {
                  lastSave.current = current;
                  setPosition(current);
                  saveDraft(`course:${item.id}`, { position: current });
                }
              }}
              onEnded={() =>
                recordAttempt({
                  itemId: item.id,
                  title: item.title,
                  kind: item.kind,
                  durationSeconds: Number(data.durationSeconds) || 0,
                  detail: "公开课播放结束",
                })
              }
            />
            <div className="study-toolbar">
              <span className="study-muted">播放进度自动保存</span>
              <label>
                倍速{" "}
                <select
                  value={rate}
                  onChange={(e) => setPlaybackRate(e.target.value)}
                >
                  {["0.75", "1", "1.25", "1.5", "2"].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </label>
            </div>
          </>
        ) : audio ? (
          <Audio item={item} source={audio.local} label="课堂录音" />
        ) : (
          <Empty>这节课的归档没有可播放的音视频。</Empty>
        )}
        {failed && (
          <p className="study-warning" role="alert">
            视频加载失败，请检查归档文件或尝试纯音频。
          </p>
        )}
      </section>
      {slides.length > 0 && (
        <section className="study-panel study-slides">
          <div className="study-toolbar">
            <h3>课堂课件</h3>
            <Pager index={index} count={slides.length} onChange={setIndex} />
          </div>
          <figure>
            <img
              src={slides[index].url}
              alt={`${slides[index].title} · 第 ${slides[index].number} 页`}
              loading="lazy"
            />
            <figcaption>
              {slides[index].title} · 第 {slides[index].number} 页
            </figcaption>
          </figure>
          <div className="study-slide-thumbs">
            {slides.map((slide: Row, n: number) => (
              <button
                key={`${slide.url}-${n}`}
                className={index === n ? "is-active" : ""}
                onClick={() => setIndex(n)}
                aria-label={`查看课件第 ${n + 1} 页`}
              >
                {n + 1}
              </button>
            ))}
          </div>
          <p className="study-muted study-footnote">课件为已保存的页面图片。</p>
        </section>
      )}
    </div>
  );
}

function Workspace({
  item,
  reviewAttempt,
}: {
  item: StudyItem;
  reviewAttempt?: Attempt;
}) {
  switch (item.kind) {
    case "writing":
      return <Writing item={item} reviewAttempt={reviewAttempt} />;
    case "speaking":
      return <Speaking item={item} />;
    case "vocabulary":
      return <Vocabulary item={item} reviewAttempt={reviewAttempt} />;
    case "sentences":
    case "numbers":
      return <Dictation item={item} reviewAttempt={reviewAttempt} />;
    case "grammar":
      return <Grammar item={item} />;
    case "typing":
      return <Typing item={item} />;
    case "courses":
      return <Courses item={item} />;
    default:
      return <Empty />;
  }
}
export default function StudyWorkspace({
  item,
  reviewAttempt,
}: {
  item: StudyItem;
  reviewAttempt?: Attempt;
}) {
  return (
    <div className="study-workspace">
      {reviewAttempt &&
        ["vocabulary", "sentences", "numbers"].includes(item.kind) && (
          <p className="study-review-notice">
            正在复习历史记录中的题目 · 作答后保存新进度
          </p>
        )}
      <Workspace
        key={`${item.kind}:${item.id}:${reviewAttempt?.id || "resume"}`}
        item={item}
        reviewAttempt={reviewAttempt}
      />
    </div>
  );
}
