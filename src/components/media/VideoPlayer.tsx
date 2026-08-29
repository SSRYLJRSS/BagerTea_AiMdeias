/**
 * VideoPlayer（指导书 §4.4/§4.5 + FB3-03 §5.2）：统一视频播放器。
 *  状态机：loading → ready → playing/paused；autoplayBlocked（自动播放被拒）；
 *          error（解码失败，携带 MediaError.code）；proxying（上层正在生成兼容代理）。
 *  功能：播放/暂停、±5 秒、进度条、当前/总时长、倍速 0.5/1/1.5/2、静音、音量、全屏。
 * 键盘作用域（焦点在播放器根节点）：
 *   ArrowLeft/Right = seek ±5s；Space/K = 播放/暂停；M = 静音；F = 全屏。
 *  事件执行后 stopPropagation()；仅在执行 seek/play 快捷键时 preventDefault()。
 * FB3-03 高度契约（§5.2，与 Immich VideoNativeViewer 同构）：
 *  根节点 h-full w-full flex-col → 媒体区 min-h-0 flex-1（video max-h-full object-contain）
 *  → 控制条 shrink-0。视频固有高度被 flex-1 媒体区约束，控制条永远在可视舞台内，
 *  不再依赖外层 overflow-hidden 之外的兄弟节点（旧结构 max-h-full 在视频先占满舞台时
 *  把控制条推到舞台下方被裁掉）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Loader2, Play } from "lucide-react";
import VideoControls, { fmtTime } from "@/components/media/VideoControls";

export type VideoPlayerStatus =
  | "loading"
  | "ready"
  | "playing"
  | "paused"
  | "autoplayBlocked"
  | "error"
  | "proxying";

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
  onMetrics?: (m: VideoMetrics) => void;
  /** 原文件播放失败回调（携带 MediaError.code），供上层决定是否生成兼容代理。 */
  onError?: (code?: number) => void;
  /** 上层正在生成兼容代理（显示处理中 + 取消入口）。 */
  proxying?: boolean;
  /** 代理失败原因（显示重试入口）。 */
  proxyError?: string | null;
  onCancelProxy?: () => void;
  onRetryProxy?: () => void;
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

export default function VideoPlayer({
  src,
  fileName,
  className,
  onMetrics,
  onError,
  proxying = false,
  proxyError = null,
  onCancelProxy,
  onRetryProxy,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<VideoPlayerStatus>("loading");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [muted, setMuted] = useState(true);
  const [volume, setVolume] = useState(1);
  const [fs, setFs] = useState(false);
  const timeRef = useRef({ loadedmetadata: 0, canplay: 0 });
  const lastErrorCode = useRef<number | undefined>(undefined);

  const canPlayType = useCallback(() => {
    const v = videoRef.current;
    if (!v) return {};
    const probes = [
      "video/mp4",
      'video/mp4; codecs="avc1.42E01E"',
      'video/webm; codecs="vp9"',
      "video/quicktime",
      "video/x-matroska",
      'video/mp4; codecs="hev1"',
    ];
    const out: Record<string, boolean> = {};
    for (const t of probes) out[t] = v.canPlayType(t) !== "";
    return out;
  }, []);

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

  // 尝试自动播放（原 mute 自动播放；被拒 → autoplayBlocked 而非静默吞错）
  const tryAutoplay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const p = v.play();
    // 某些环境（jsdom/旧 WebView）play() 同步返回 undefined：无 Promise 可等，视为已发起
    if (!p || typeof p.then !== "function") {
      setStatus("playing");
      return;
    }
    p.then(() => {
      setStatus((s) => (s === "autoplayBlocked" ? s : "playing"));
    }).catch((e: unknown) => {
      const name = e instanceof DOMException ? e.name : "";
      if (name === "NotAllowedError" || name === "AbortError") {
        setStatus("autoplayBlocked");
      } else {
        setStatus("paused");
      }
    });
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      const p = v.play();
      if (!p || typeof p.then !== "function") {
        setStatus("playing");
        return;
      }
      p.then(() => setStatus("playing")).catch(() => setStatus("autoplayBlocked"));
    } else {
      v.pause();
      setStatus("paused");
    }
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

  // §4.4 键盘作用域：焦点在播放器根节点时接管快捷键；执行后 stopPropagation，
  // 只有 seek/play 快捷键 preventDefault（防止页面级 ←→ 切素材、Space 滚动）。
  const onRootKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
      const handled = ["ArrowLeft", "ArrowRight", " ", "k", "K", "m", "M", "f", "F"].includes(e.key);
      if (!handled) return;
      // 快捷键统一不回传查看器（播放器优先级高于页面切片）
      e.stopPropagation();
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          seekDelta(-5);
          break;
        case "ArrowRight":
          e.preventDefault();
          seekDelta(5);
          break;
        case " ":
        case "k":
        case "K":
          e.preventDefault();
          togglePlay();
          break;
        case "m":
        case "M":
          toggleMute();
          break;
        case "f":
        case "F":
          toggleFullscreen();
          break;
      }
    },
    [seekDelta, togglePlay, toggleMute, toggleFullscreen],
  );

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onErr = () => {
      const code = v.error?.code;
      lastErrorCode.current = code;
      setStatus("error");
      emitMetrics({ errorCode: code });
      onError?.(code);
    };
    const onLoaded = () => {
      setDuration(Number.isFinite(v.duration) ? v.duration : 0);
      timeRef.current.loadedmetadata = performance.now();
      emitMetrics({ loadedmetadataMs: timeRef.current.loadedmetadata });
      setStatus((s) => (s === "proxying" ? s : "ready"));
    };
    const onCanplay = () => {
      timeRef.current.canplay = performance.now();
      emitMetrics({ canplayMs: timeRef.current.canplay });
    };
    const onStalled = () => emitMetrics({ stalled: true });
    const onWaiting = () => emitMetrics({ waiting: true });
    const onTime = () => setCurrentTime(v.currentTime);
    const onPlay = () => setStatus("playing");
    const onPause = () => setStatus((s) => (s === "playing" || s === "ready" ? "paused" : s));
    const onEnded = () => setStatus("paused");
    v.addEventListener("error", onErr);
    v.addEventListener("loadedmetadata", onLoaded);
    v.addEventListener("canplay", onCanplay);
    v.addEventListener("stalled", onStalled);
    v.addEventListener("waiting", onWaiting);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("ended", onEnded);
    // mount 时上报一次支持矩阵 + 初始状态
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
      v.removeEventListener("ended", onEnded);
    };
  }, [emitMetrics, onError]);

  useEffect(() => {
    const onFs = () => setFs(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // src 变化：重置状态并重新加载，切换素材不残留上一段错误/时间
  useEffect(() => {
    setStatus("loading");
    setCurrentTime(0);
    setDuration(0);
    lastErrorCode.current = undefined;
    const v = videoRef.current;
    if (v) {
      try {
        v.load();
      } catch {
        /* 忽略 */
      }
    }
  }, [src]);

  // 自动播放：muted 首帧尝试（loadedmetadata 后再 play，稳妥）
  useEffect(() => {
    if (status !== "ready") return;
    const timer = window.setTimeout(() => tryAutoplay(), 0);
    return () => window.clearTimeout(timer);
  }, [status, tryAutoplay]);

  const durationKnown = Number.isFinite(duration) && duration > 0;
  const durationLabel = durationKnown ? fmtTime(duration) : "--:--";

  return (
    <div
      ref={boxRef}
      tabIndex={0}
      role="group"
      aria-label="视频播放器"
      data-player-root
      onKeyDown={onRootKeyDown}
      className={clsx("relative flex h-full w-full min-h-0 min-w-0 flex-col bg-black/95 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-status)]", className)}
    >
      {/* FB3-03 媒体区：flex-1 min-h-0 约束视频固有高度；object-contain 不拉伸 */}
      <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center">
        <video
          ref={videoRef}
          src={src}
          autoPlay
          muted
          playsInline
          onClick={(e) => {
            e.stopPropagation();
            togglePlay();
          }}
          className="h-full w-full object-contain"
        />
      </div>

      {/* 加载中 */}
      {status === "loading" && !proxying && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60">
          <Loader2 size={20} className="animate-spin text-[var(--color-text-secondary)]" aria-hidden="true" />
          <p className="text-xs text-[var(--color-text-secondary)]">正在加载视频…</p>
        </div>
      )}

      {/* 自动播放被拒：点击播放，不静默吞错 */}
      {status === "autoplayBlocked" && !proxying && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            togglePlay();
          }}
          aria-label="点击播放"
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/50 text-[var(--color-text)] transition-colors hover:bg-black/40"
        >
          <Play size={28} strokeWidth={1.75} aria-hidden="true" />
          <span className="text-sm">点击播放</span>
        </button>
      )}

      {/* 解码失败 */}
      {status === "error" && !proxying && !proxyError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 px-4 text-center">
          <p className="text-sm text-[var(--color-danger)]">⚠ 播放失败</p>
          <p className="max-w-full truncate text-xs text-[var(--color-text-secondary)]">{fileName}</p>
          <p className="text-xs text-[var(--color-text-secondary)]">{errorText(lastErrorCode.current)}</p>
          <p className="text-[10px] text-[var(--color-text-tertiary)]">错误码 {lastErrorCode.current ?? "--"}</p>
        </div>
      )}

      {/* 正在生成兼容代理 */}
      {proxying && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 px-4 text-center">
          <Loader2 size={20} className="animate-spin text-[var(--color-text-secondary)]" aria-hidden="true" />
          <p className="text-xs text-[var(--color-text-secondary)]">正在生成兼容代理（H.264）…</p>
          {onCancelProxy && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onCancelProxy();
              }}
              className="rounded bg-[var(--color-surface-hover)] px-2 py-1 text-xs text-[var(--color-text)]"
            >
              取消
            </button>
          )}
        </div>
      )}

      {/* 代理失败：原因 + 重试 */}
      {proxyError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 px-4 text-center">
          <p className="max-w-full truncate text-xs text-[var(--color-danger)]">{proxyError}</p>
          <p className="text-xs text-[var(--color-text-secondary)]">
            建议：安装 HEVC 视频扩展，或改用 H.264/AAC 编码的原文件后重新打开。
          </p>
          {onRetryProxy && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRetryProxy();
              }}
              className="rounded bg-[var(--color-surface-hover)] px-2 py-1 text-xs text-[var(--color-text)]"
            >
              重试生成兼容代理
            </button>
          )}
        </div>
      )}

      {(!durationKnown || status !== "loading") && (
        <VideoControls
          playing={status === "playing"}
          currentTime={currentTime}
          duration={duration}
          durationKnown={durationKnown}
          rate={rate}
          muted={muted}
          volume={volume}
          fullscreen={fs}
          onTogglePlay={togglePlay}
          onSeekDelta={seekDelta}
          onSeekTo={(t) => {
            const v = videoRef.current;
            if (v) v.currentTime = t;
            setCurrentTime(t);
          }}
          onRate={(r) => {
            const v = videoRef.current;
            if (v) v.playbackRate = r;
            setRate(r);
          }}
          onToggleMute={toggleMute}
          onVolume={changeVolume}
          onToggleFullscreen={toggleFullscreen}
        />
      )}

      {/* 无障碍时间信息（duration 未知时提示加载文案；控制条常驻不因 duration 未知整条隐藏） */}
      {!durationKnown && status !== "loading" && (
        <div className="sr-only">{durationLabel}</div>
      )}
    </div>
  );
}