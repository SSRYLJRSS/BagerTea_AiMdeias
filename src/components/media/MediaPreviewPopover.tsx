/** 悬浮预览浮层（指导书阶段 4 §7.3）：
 *  最大宽度约 420px，最大高度不超过窗口可用高度 70%；位置自动避让左右和上下边界。
 *  作为触发器的 DOM 子元素渲染，指针移入浮层时保持打开（不触发 onMouseLeave）。 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 计算浮层位置（视口坐标系，position:fixed 用），自动避让左右/上下边界。
 *  默认在触发器下方居中；若会超出底部则改到上方；左右用边距钳制。 */
export function computePopoverPosition(
  trigger: Rect,
  popover: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const margin = 8;
  const left = Math.max(
    margin,
    Math.min(viewport.width - popover.width - margin, trigger.left + trigger.width / 2 - popover.width / 2),
  );
  let top = trigger.top + trigger.height + margin;
  if (top + popover.height > viewport.height - margin) {
    top = trigger.top - popover.height - margin;
  }
  top = Math.max(margin, top);
  return { left, top };
}

export default function MediaPreviewPopover({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      // 最近定位祖先 = 触发器的 relative 包裹层
      const triggerEl = (el.offsetParent as HTMLElement | null) ?? el.parentElement;
      if (!triggerEl) return;
      const tw = triggerEl.getBoundingClientRect();
      const pop = el.getBoundingClientRect();
      const vp = { width: window.innerWidth, height: window.innerHeight };
      setPos(
        computePopoverPosition(
          { left: tw.left, top: tw.top, width: tw.width, height: tw.height },
          { width: pop.width, height: pop.height },
          vp,
        ),
      );
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-hidden="false"
      className={clsx("pointer-events-none fixed z-40 not-print", className)}
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        opacity: pos ? 1 : 0,
      }}
    >
      <div className="pointer-events-auto max-h-[70vh] min-w-[240px] max-w-[420px] overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] shadow-lg">
        {children}
      </div>
    </div>
  );
}
