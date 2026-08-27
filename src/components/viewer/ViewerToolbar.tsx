/**
 * ViewerToolbar（指导书 §2.3/§4.1）：查看器顶部工具栏。
 * 返回/关闭 · 文件名 · 位置 · 详情开关。图标统一 lucide-react，按钮带 aria-label。
 */
import { ArrowLeft, Info, X } from "lucide-react";

interface ViewerToolbarProps {
  fileName: string;
  /** 当前位置文案，如 "3 / 120" */
  position: string;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  onClose: () => void;
}

export default function ViewerToolbar({ fileName, position, detailsOpen, onToggleDetails, onClose }: ViewerToolbarProps) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-2">
      <button
        type="button"
        onClick={onClose}
        aria-label="返回素材库"
        title="返回素材库（Esc）"
        className="flex size-9 shrink-0 items-center justify-center rounded-md text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
      >
        <ArrowLeft size={16} strokeWidth={2} aria-hidden="true" />
      </button>
      <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-text)]" title={fileName}>
        {fileName}
      </span>
      <span className="shrink-0 text-xs text-[var(--color-text-secondary)]">{position}</span>
      <button
        type="button"
        onClick={onToggleDetails}
        aria-label={detailsOpen ? "隐藏详情" : "显示详情"}
        title={detailsOpen ? "隐藏详情" : "显示详情"}
        className={clsxBtn(detailsOpen)}
      >
        <Info size={16} strokeWidth={1.75} aria-hidden="true" />
        <span className="text-xs">详情</span>
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label="关闭查看器"
        title="关闭查看器（Esc）"
        className="flex size-9 shrink-0 items-center justify-center rounded-md text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
      >
        <X size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  );
}

function clsxBtn(active: boolean) {
  return `flex h-9 shrink-0 items-center gap-1 rounded-md px-2 transition-colors ${
    active
      ? "bg-[var(--color-surface)] text-[var(--color-text)]"
      : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
  }`;
}