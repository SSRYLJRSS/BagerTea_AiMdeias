/**
 * ViewerToolbar（指导书 §2.3/§4.1 + FB3-04 §6.2 + FB5-01 §4.1）：查看器顶部工具栏。
 *  返回/关闭 · 文件名 · 位置 · 信息开关 · 全屏浏览。
 *  FB3-04：「详情」改为「信息」（仍控制左侧属性栏）；新「全屏浏览」= 查看器级全屏。
 *  FB5-01：prop 名从含糊 fullscreen 收敛为 immersive（与状态机一致）；进入按钮 title 提示 Esc 退出。
 */
import { ArrowLeft, Info, Maximize2, Minimize2, X } from "lucide-react";

interface ViewerToolbarProps {
  fileName: string;
  /** 当前位置文案，如 "3 / 120" */
  position: string;
  /** 左侧属性信息栏开关（FB3-04：语义改为「信息」） */
  detailsOpen: boolean;
  onToggleDetails: () => void;
  /** FB5-01：沉浸浏览状态 */
  immersive: boolean;
  onToggleImmersive: () => void;
  onClose: () => void;
}

export default function ViewerToolbar({ fileName, position, detailsOpen, onToggleDetails, immersive, onToggleImmersive, onClose }: ViewerToolbarProps) {
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
        aria-label={detailsOpen ? "隐藏信息面板" : "显示信息面板"}
        title={detailsOpen ? "隐藏信息面板" : "显示信息面板"}
        className={clsxBtn(detailsOpen)}
      >
        <Info size={16} strokeWidth={1.75} aria-hidden="true" />
        <span className="text-xs">信息</span>
      </button>
      <button
        type="button"
        onClick={onToggleImmersive}
        aria-label={immersive ? "退出全屏浏览" : "全屏浏览"}
        title={immersive ? "退出全屏浏览（Esc）" : "全屏浏览（Esc 退出）"}
        className="flex h-9 shrink-0 items-center gap-1 rounded-md px-2 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
      >
        {immersive ? <Minimize2 size={16} strokeWidth={1.75} aria-hidden="true" /> : <Maximize2 size={16} strokeWidth={1.75} aria-hidden="true" />}
        <span className="text-xs">全屏浏览</span>
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
