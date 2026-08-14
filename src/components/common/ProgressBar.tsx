import clsx from "clsx";

interface ProgressBarProps {
  /** 0..1 */
  value: number;
  className?: string;
}

export default function ProgressBar({ value, className }: ProgressBarProps) {
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
