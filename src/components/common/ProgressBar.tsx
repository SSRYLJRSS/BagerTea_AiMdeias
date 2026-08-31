import clsx from "clsx";

interface ProgressBarProps {
  /** 0..1（indeterminate 时忽略） */
  value: number;
  /** 不确定进度：总量未知（total<=0）或尚未收到首个进度事件时使用，不显示 NaN%（FB6 需求一） */
  indeterminate?: boolean;
  className?: string;
}

export default function ProgressBar({ value, indeterminate = false, className }: ProgressBarProps) {
  if (indeterminate) {
    return (
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        className={clsx("h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-border)]", className)}
      >
        <div className="startup-indeterminate h-full w-1/3 rounded-full bg-[var(--color-accent)]" />
      </div>
    );
  }
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      className={clsx("h-1.5 w-full rounded-full bg-[var(--color-border)] overflow-hidden", className)}
    >
      <div className="h-full bg-[var(--color-accent)] transition-[width]" style={{ width: `${pct}%` }} />
    </div>
  );
}
