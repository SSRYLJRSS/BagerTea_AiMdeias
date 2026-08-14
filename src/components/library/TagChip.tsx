/** 标签小片：展示 / 可选中 / 可移除 */
import clsx from "clsx";

interface TagChipProps {
  label: string;
  active?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
}

export default function TagChip({ label, active, onClick, onRemove }: TagChipProps) {
  return (
    <span
      onClick={onClick}
      className={clsx(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors",
        active
          ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-text)]"
          : "border-[var(--color-border)] text-[var(--color-text)] hover:border-[var(--color-accent)]",
        onClick && "cursor-pointer",
      )}
    >
      {label}
      {onRemove && (
        <button
          aria-label={`移除标签 ${label}`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="opacity-60 hover:opacity-100"
        >
          ×
        </button>
      )}
    </span>
  );
}
