/**
 * VideoControls（指导书 §3.4/§4.4/§5 + FB5-01 §4.4）：视频画面内悬浮控制条。
 *  - absolute bottom 浮层，不再参与视频高度计算（video 不再 flex-col 给控制条留位）；
 *  - 自定义进度：base / buffered / played 三层 + 透明 range 只留 thumb（.video-range 样式见 index.css）；
 *  - 倍速菜单：紧凑 1x 按钮 + 向上展开菜单（Check 标记当前速度，Esc/点击外部关闭）；
 *  - 响应式：<640px 隐藏常驻音量滑条（hover 音量按钮弹出小浮层）；<480px 隐藏非核心控件；
 *  - 所有交互 stopPropagation，不得误触视频播放/双击沉浸。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Check, Maximize, Minimize, Pause, Play, RotateCcw, RotateCw, Volume2, VolumeX } from "lucide-react";

export const RATES = [0.5, 1, 1.5, 2] as const;

interface VideoControlsProps {
  playing: boolean;
  currentTime: number;
  duration: number;
  durationKnown: boolean;
  bufferedEnd: number;
  rate: number;
  muted: boolean;
  volume: number;
  /** FB5-01（§4.4）：统一沉浸状态（由 ViewerPage 状态机驱动，播放器不再有自己的 fullscreen） */
  immersive: boolean;
  onTogglePlay: () => void;
  onSeekDelta: (delta: number) => void;
  onSeekTo: (t: number) => void;
  onRate: (r: number) => void;
  onToggleMute: () => void;
  onVolume: (v: number) => void;
  onToggleImmersive: () => void;
}

export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${m}:${String(ss).padStart(2, "0")}`;
}

const btnCls =
  "flex size-8 shrink-0 items-center justify-center rounded-md text-white/90 transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/40";

/** 百分比安全换算：非有限/负数返回 0 */
function pct(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.max(0, Math.min(100, (value / max) * 100));
}

/** 自定义进度条：base/buffered/played 三层 + 透明 range 只保留交互与 thumb */
function PlaybackSlider({
  value,
  max,
  buffered,
  disabled,
  onChange,
  onScrub,
}: {
  value: number;
  max: number;
  buffered: number;
  disabled: boolean;
  onChange: (t: number) => void;
  onScrub: (active: boolean) => void;
}) {
  const played = pct(value, max);
  const buf = pct(buffered, max);
  return (
    <div className="group/slider relative flex h-5 w-full items-center" data-testid="playback-slider">
      {/* base track */}
      <div className="absolute inset-x-0 h-1 rounded-full bg-white/24" aria-hidden="true" />
      {/* buffered track */}
      <div className="absolute left-0 h-1 rounded-full bg-white/38" style={{ width: `${buf}%` }} aria-hidden="true" />
      {/* played track */}
      <div className="absolute left-0 h-1 rounded-full bg-white" style={{ width: `${played}%` }} aria-hidden="true" />
      {/* 透明 range：只留交互与 thumb（样式见 .video-range） */}
      <input
        type="range"
        aria-label="播放进度"
        min={0}
        max={max || 0}
        step={0.01}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerDown={() => onScrub(true)}
        onPointerUp={() => onScrub(false)}
        onKeyDown={(e) => e.stopPropagation()}
        className="video-range absolute inset-0 h-full w-full"
      />
    </div>
  );
}

export default function VideoControls({
  playing,
  currentTime,
  duration,
  durationKnown,
  bufferedEnd,
  rate,
  muted,
  volume,
  immersive,
  onTogglePlay,
  onSeekDelta,
  onSeekTo,
  onRate,
  onToggleMute,
  onVolume,
  onToggleImmersive,
}: VideoControlsProps) {
  const [rateOpen, setRateOpen] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const rateRef = useRef<HTMLDivElement>(null);

  // 倍速菜单：点击外部 / Esc 关闭
  useEffect(() => {
    if (!rateOpen) return;
    const onDocDown = (e: MouseEvent) => {
      if (rateRef.current && !rateRef.current.contains(e.target as Node)) setRateOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRateOpen(false);
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onEsc);
    };
  }, [rateOpen]);

  // 控制条内所有交互不得冒泡到视频/沉浸双击（§3.4）
  const stop = useCallback((e: React.SyntheticEvent) => e.stopPropagation(), []);

  const maxTime = duration || 0;

  return (
    <div
      data-testid="video-controls"
      className="pointer-events-auto absolute bottom-4 left-1/2 w-[min(760px,calc(100%-24px))] -translate-x-1/2 min-h-16 rounded-lg border border-white/12 bg-[rgba(20,20,22,0.82)] px-3 pb-1.5 pt-1 shadow-lg backdrop-blur-xl transition-opacity duration-200"
      onClick={stop}
      onDoubleClick={stop}
      onPointerDown={stop}
    >
      <div className="flex flex-col gap-0.5">
        {/* 进度层（20px） */}
        <PlaybackSlider
          value={currentTime}
          max={maxTime}
          buffered={bufferedEnd}
          disabled={!durationKnown}
          onChange={(t) => onSeekTo(t)}
          onScrub={setScrubbing}
        />
        {/* 按钮层（36px） */}
        <div className="flex items-center gap-0.5">
          <button type="button" onClick={(e) => { stop(e); onTogglePlay(); }} aria-label={playing ? "暂停" : "播放"} title={playing ? "暂停" : "播放"} className={btnCls}>
            {playing ? <Pause size={17} strokeWidth={1.75} aria-hidden="true" /> : <Play size={17} strokeWidth={1.75} aria-hidden="true" />}
          </button>
          <button type="button" onClick={(e) => { stop(e); onSeekDelta(-5); }} aria-label="后退 5 秒" title="后退 5 秒" className={clsx(btnCls, "max-sm:hidden")}>
            <RotateCcw size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button type="button" onClick={(e) => { stop(e); onSeekDelta(5); }} aria-label="前进 5 秒" title="前进 5 秒" className={clsx(btnCls, "max-sm:hidden")}>
            <RotateCw size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>

          <span className="shrink-0 px-1.5 text-[11px] tabular-nums text-white/80">
            {fmtTime(scrubbing ? currentTime : currentTime)} / {fmtTime(maxTime)}
          </span>

          {/* 倍速菜单：紧凑 1x 按钮 + 向上展开菜单 */}
          <div ref={rateRef} className="relative shrink-0">
            <button
              type="button"
              onClick={(e) => { stop(e); setRateOpen((v) => !v); }}
              aria-label="倍速"
              aria-haspopup="menu"
              aria-expanded={rateOpen}
              title="倍速"
              className={clsx(btnCls, "w-auto px-2 text-xs tabular-nums max-sm:hidden")}
            >
              {rate}x
            </button>
            {rateOpen && (
              <div
                role="menu"
                aria-label="倍速选项"
                className="absolute bottom-full left-0 z-10 mb-1.5 min-w-20 rounded-lg border border-white/12 bg-[rgba(20,20,22,0.95)] py-1 shadow-lg"
              >
                {RATES.map((r) => (
                  <button
                    key={r}
                    type="button"
                    role="menuitemradio"
                    aria-checked={rate === r}
                    onClick={(e) => {
                      stop(e);
                      onRate(r);
                      setRateOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-white/90 transition-colors hover:bg-white/10"
                  >
                    <span className="w-4 shrink-0">{rate === r && <Check size={13} strokeWidth={2} aria-hidden="true" />}</span>
                    <span className="tabular-nums">{r}x</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="min-w-0 flex-1" aria-hidden="true" />

          {/* 静音 + 音量。窄屏：隐藏常驻滑条，hover 静音按钮弹出音量浮层（§5.5） */}
          <div className="group/vol relative flex shrink-0 items-center">
            <button
              type="button"
              onClick={(e) => { stop(e); onToggleMute(); }}
              aria-label={muted ? "取消静音" : "静音"}
              title={muted ? "取消静音" : "静音"}
              className={btnCls}
            >
              {muted ? <VolumeX size={16} strokeWidth={1.75} aria-hidden="true" /> : <Volume2 size={16} strokeWidth={1.75} aria-hidden="true" />}
            </button>
            {/* 窄屏音量浮层：hover 弹出；sm 及以上隐藏（常驻滑条接管） */}
            <div className="absolute bottom-full left-1/2 mb-1 hidden -translate-x-1/2 rounded-lg border border-white/12 bg-[rgba(20,20,22,0.95)] p-2 shadow-lg group-hover/vol:block sm:hidden">
              <input
                type="range"
                aria-label="音量（窄屏）"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                onChange={(e) => onVolume(Number(e.target.value))}
                onKeyDown={(e) => e.stopPropagation()}
                className="video-range h-16 w-2 [writing-mode:vertical-lr] [direction:rtl]"
              />
            </div>
          </div>
          <input
            type="range"
            aria-label="音量"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={(e) => onVolume(Number(e.target.value))}
            onKeyDown={(e) => e.stopPropagation()}
            className="video-range hidden w-[72px] shrink-0 sm:block"
          />

          {/* 全屏：统一沉浸入口，不直接 requestFullscreen（§4.4） */}
          <button
            type="button"
            onClick={(e) => { stop(e); onToggleImmersive(); }}
            aria-label={immersive ? "退出全屏" : "全屏"}
            title={immersive ? "退出全屏（Esc）" : "全屏"}
            className={btnCls}
          >
            {immersive ? <Minimize size={16} strokeWidth={1.75} aria-hidden="true" /> : <Maximize size={16} strokeWidth={1.75} aria-hidden="true" />}
          </button>
        </div>
      </div>
    </div>
  );
}
