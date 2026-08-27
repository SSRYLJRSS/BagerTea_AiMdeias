/**
 * VideoControls（指导书 §4.4/§3.2）：视频控制条。
 *  - lucide-react 图标，普通按钮 16–18px，统一 strokeWidth 1.75；
 *  - 全量 aria-label/title；装饰图标 aria-hidden；
 *  - 控制条宽度跟随播放器（外层容器约束），窄窗口可横向滚动/折行。
 */
import { Maximize, Minimize, Pause, Play, RotateCcw, RotateCw, Volume2, VolumeX } from "lucide-react";

export const RATES = [0.5, 1, 1.5, 2] as const;

interface VideoControlsProps {
  playing: boolean;
  currentTime: number;
  duration: number;
  durationKnown: boolean;
  rate: number;
  muted: boolean;
  volume: number;
  fullscreen: boolean;
  onTogglePlay: () => void;
  onSeekDelta: (delta: number) => void;
  onSeekTo: (t: number) => void;
  onRate: (r: number) => void;
  onToggleMute: () => void;
  onVolume: (v: number) => void;
  onToggleFullscreen: () => void;
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
  "flex size-7 shrink-0 items-center justify-center rounded text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]";

export default function VideoControls({
  playing,
  currentTime,
  duration,
  durationKnown,
  rate,
  muted,
  volume,
  fullscreen,
  onTogglePlay,
  onSeekDelta,
  onSeekTo,
  onRate,
  onToggleMute,
  onVolume,
  onToggleFullscreen,
}: VideoControlsProps) {
  const maxTime = duration || 0;
  return (
    <div className="shrink-0 overflow-x-auto border-t border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2 py-1.5">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onTogglePlay} aria-label={playing ? "暂停" : "播放"} title={playing ? "暂停" : "播放"} className={btnCls}>
          {playing ? <Pause size={16} strokeWidth={1.75} aria-hidden="true" /> : <Play size={16} strokeWidth={1.75} aria-hidden="true" />}
        </button>
        <button type="button" onClick={() => onSeekDelta(-5)} aria-label="后退 5 秒" title="后退 5 秒" className={btnCls}>
          <RotateCcw size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button type="button" onClick={() => onSeekDelta(5)} aria-label="前进 5 秒" title="前进 5 秒" className={btnCls}>
          <RotateCw size={16} strokeWidth={1.75} aria-hidden="true" />
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
          disabled={!durationKnown}
          onChange={(e) => onSeekTo(Number(e.target.value))}
          className="min-w-0 flex-1 disabled:opacity-40"
        />

        <select
          aria-label="倍速"
          value={rate}
          title="倍速"
          onChange={(e) => onRate(Number(e.target.value))}
          className="shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 text-[11px] text-[var(--color-text)]"
        >
          {RATES.map((r) => (
            <option key={r} value={r}>{r}x</option>
          ))}
        </select>

        <button type="button" onClick={onToggleMute} aria-label={muted ? "取消静音" : "静音"} title={muted ? "取消静音" : "静音"} className={btnCls}>
          {muted ? <VolumeX size={16} strokeWidth={1.75} aria-hidden="true" /> : <Volume2 size={16} strokeWidth={1.75} aria-hidden="true" />}
        </button>
        <input
          type="range"
          aria-label="音量"
          min={0}
          max={1}
          step={0.05}
          value={muted ? 0 : volume}
          onChange={(e) => onVolume(Number(e.target.value))}
          className="w-16 shrink-0"
        />

        <button type="button" onClick={onToggleFullscreen} aria-label="全屏" title="全屏" className={btnCls}>
          {fullscreen ? <Minimize size={16} strokeWidth={1.75} aria-hidden="true" /> : <Maximize size={16} strokeWidth={1.75} aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}