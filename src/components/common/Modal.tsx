import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** 宽版（预览等场景） */
  wide?: boolean;
}

/** 基础模态：遮罩点击/Esc 关闭（T04 弹窗统一基于它）
 *  Esc 走 window 捕获阶段监听：不依赖弹窗内部焦点，打开期间必然可靠关闭；
 *  stopPropagation 拦截后不再冒泡到 window 气泡阶段的其它 Esc 监听
 *  （右键菜单/useEscape），避免重复触发，关闭/卸载自动清理
 */
export default function Modal({ open, title, onClose, children, footer, wide }: ModalProps) {
  // 最新回调引用：避免父组件内联 onClose 变化导致监听反复拆装
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={wide ? "w-[860px] max-w-[92vw] rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] shadow-xl" : "w-[420px] max-w-[90vw] rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] shadow-xl"}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-[var(--color-border)] text-sm font-medium">{title}</div>
        <div className="px-5 py-4 text-sm">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-[var(--color-border)] flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}
