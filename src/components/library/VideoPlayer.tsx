/** 统一视频播放器（指导书阶段 3 §6.5）：
 *  播放/暂停、后退/前进 5 秒、时间轴、当前时间/总时长、倍速菜单（0.5/1/1.5/2x）、
 *  静音/音量、全屏；播放错误显示错误状态与文件名。不使用负 playbackRate 倒放。
 *  控件按钮带 aria-label 和 title；使用现有主题变量，不以纯底/纯红大色块装饰。 */
import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";

/** §6.2 视频测量快照：canPlayType / 错误码 / 网络与就绪状态 / 关键事件时间。 */
export interface VideoMetrics {
  canPlayType: Record<string, boolean>;
  errorCode?: number;
  networkState?: number;
  readyState?: number;
  loadedmetadataMs?: number;
  canplayMs?: number;
  stalled?: boolean;
  waiting?: boolean;
}

interface VideoPlayerProps {
  src: string;
  fileName: string;
  className?: string;
  /** §6.2：把测量数据回传（真机 spike 用），可选。 */
  onMetrics?: (m: VideoMetrics) => void;
}

const RATES = [0.5, 1, 1.5, 2] as const;

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
    : `${m}:${String(ss).padStart(2, "0")}`;
}

function errorText(code?: number): string {
  switch (code) {
    case 1:
      return "播放被中止";
    case 2:
      return "发生网络错误";
    case 3:
      return "解码失败（编码可能不受支持）";
    case 4:
      return "格式不受支持";
    default:
      return "无法播放该视频";
  }
}

export default function VideoPlayer({ src, fileName, className, onMetrics }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [fs, setFs] = useState(false);
  const timeRef = useRef({ loadedmetadata: 0, canplay: 0 });

  // §6.2：支持矩阵编码探测（canPlayType）
  const canPlayType = useCallback(() => {
    const v = videoRef.current;
    if (!v) return {};
    const probes = ["video/mp4", "video/mp4; codecs=\"avc1.42E01E\"", "video/webm; codecs=\"vp9\"", "video/quicktime", "video/x-matroska", "video/mp4; codecs=\"hev1\""];
    const out: Record<string, boolean> = {};
    for (const t of probes) out[t] = v.canPlayType(t) !== "";
    return out;
  }, []);

  // §6.2：上报一次测量快照（mount 时 + 关键事件时）
  const emitMetrics = useCallback(
    (patch: Partial<VideoMetrics> = {}) => {
      if (!onMetrics) return;
      const v = videoRef.current;
      onMetrics({
        canPlayType: canPlayType(),
        errorCode: v?.error?.code,
        networkState: v?.networkState,
        readyState: v?.readyState,
        loadedmetadataMs: timeRef.current.loadedmetadata || undefined,
        canplayMs: timeRef.current.canplay || undefined,
        ...patch,
      });
    },
    [onMetrics, canPlayType],
  );

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  }, []);

  const seekDelta = useCallback((delta: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(Number.isFinite(v.duration) ? v.duration : v.currentTime, v.currentTime + delta));
  }, []);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  }, []);

  const changeVolume = useCallback(
    (next: number) => {
      const v = videoRef.current;
      if (!v) return;
      const val = Math.max(0, Math.min(1, next));
      v.volume = val;
      setVolume(val);
      if (val > 0 && v.muted) {
        v.muted = false;
        setMuted(false);
      }
    },
    [],
  );

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void boxRef.current?.requestFullscreen();
    }
  }, []);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onErr = () => {
      setError(errorText(v.error?.code));
      setPlaying(false);
      emitMetrics({ errorCode: v.error?.code });
    };
    const onLoaded = () => {
      setDuration(Number.isFinite(v.duration) ? v.duration : 0);
      setError(null);
      timeRef.current.loadedmetadata = performance.now();
      emitMetrics({ loadedmetadataMs: timeRef.current.loadedmetadata });
    };
    const onCanplay = () => {
      timeRef.current.canplay = performance.now();
      emitMetrics({ canplayMs: timeRef.current.canplay });
    };
    const onStalled = () => emitMetrics({ stalled: true });
    const onWaiting = () => emitMetrics({ waiting: true });
    const onTime = () => setCurrentTime(v.currentTime);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    v.addEventListener("error", onErr);
    v.addEventListener("loadedmetadata", onLoaded);
    v.addEventListener("canplay", onCanplay);
    v.addEventListener("stalled", onStalled);
    v.addEventListener("waiting", onWaiting);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    // §6.2：mount 时上报一次支持矩阵 + 初始状态
    emitMetrics();
    return () => {
      v.removeEventListener("error", onErr);
      v.removeEventListener("loadedmetadata", onLoaded);
      v.removeEventListener("canplay", onCanplay);
      v.removeEventListener("stalled", onStalled);
      v.removeEventListener("waiting", onWaiting);
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
    };
  }, [emitMetrics]);

  useEffect(() => {
    const onFs = () => setFs(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const maxTime = duration || 0;

  return (
    <div
      ref={boxRef}
      className={clsx("relative flex max-h-full max-w-full flex-col bg-black/95", className)}
    >
      <video
        ref={videoRef}
        src={src}
        autoPlay
        playsInline
        className="max-h-full max-w-full object-contain"
        onClick={togglePlay}
      />

      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 px-4 text-center">
          <p className="text-sm text-[var(--color-success)]">⚠ 播放失败</p>
          <p className="max-w-full truncate text-xs text-[var(--color-text-secondary)]">{fileName}</p>
          <p className="text-xs text-[var(--color-danger)]">{error}</p>
        </div>
      )}

      {/* 控制器：固定高度避免出现/隐藏时布局跳动 */}
      <div className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2 py-1.5">
        <div className="flex items-center gap-2">
          <button type="button" onClick={togglePlay} aria-label={playing ? "暂停" : "播放"} title={playing ? "暂停" : "播放"}
            className="flex size-7 shrink-0 items-center justify-center rounded text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]">
            {playing ? "⏸" : "▶"}
          </button>
          <button type="button" onClick={() => seekDelta(-5)} aria-label="后退 5 秒" title="后退 5 秒"
            className="flex size-7 shrink-0 items-center justify-center rounded text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]">
            ⟲5
          </button>
          <button type="button" onClick={() => seekDelta(5)} aria-label="前进 5 秒" title="前进 5 秒"
            className="flex size-7 shrink-0 items-center justify-center rounded text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]">
            5⟳
          </button>

          <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-text-secondary)]">
            {fmtTime(currentTime)} / {fmtTime(maxTime)}
          </span>

          <input
            type="range"
            aria-label="播放进度"
            min={0}
            max={maxTime || 0}
            step={0.01}
            value={currentTime}
            onChange={(e) => {
              const t = Number(e.target.value);
              const v = videoRef.current;
              if (v) v.currentTime = t;
              setCurrentTime(t);
            }}
            className="min-w-0 flex-1"
          />

          <select
            aria-label="倍速"
            value={rate}
            title="倍速"
            onChange={(e) => {
              const r = Number(e.target.value);
              const v = videoRef.current;
              if (v) v.playbackRate = r;
              setRate(r);
            }}
            className="shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 text-[11px] text-[var(--color-text)]"
          >
            {RATES.map((r) => (
              <option key={r} value={r}>{r}x</option>
            ))}
          </select>

          <button type="button" onClick={toggleMute} aria-label={muted ? "取消静音" : "静音"} title={muted ? "取消静音" : "静音"}
            className="flex size-7 shrink-0 items-center justify-center rounded text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]">
            {muted ? "🔇" : "🔊"}
          </button>
          <input
            type="range"
            aria-label="音量"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={(e) => changeVolume(Number(e.target.value))}
            className="w-16 shrink-0"
          />

          <button type="button" onClick={toggleFullscreen} aria-label="全屏" title="全屏"
            className="flex size-7 shrink-0 items-center justify-center rounded text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]">
            {fs ? "⛶" : "⛶"}
          </button>
        </div>
      </div>
    </div>
  );
}
