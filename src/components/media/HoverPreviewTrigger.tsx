/** 悬浮预览触发器（指导书阶段 4 §7.2）：把 hover/focus 意图转成浮层显隐。
 *  通过 `content`（函数或节点）提供浮层内容；同一时间只显示一个浮层（每次激活独立实例）。
 *  切换卡片时所在触发器实例卸载，`useHoverIntent` 的 cancel 随之清理待激活/待关闭计时。 */
import type { ReactNode } from "react";
import { useHoverIntent } from "@/hooks/useHoverIntent";
import MediaPreviewPopover from "@/components/media/MediaPreviewPopover";

interface HoverPreviewTriggerProps {
  disabled?: boolean;
  /** 浮层内容；函数形式可拿到 active 状态（用于按需加载内容） */
  content: ReactNode | ((active: boolean) => ReactNode);
  children: ReactNode;
}

export default function HoverPreviewTrigger({ disabled = false, content, children }: HoverPreviewTriggerProps) {
  const { active, triggerProps } = useHoverIntent({ disabled });
  return (
    <div {...triggerProps} className="relative">
      {children}
      {active && (
        <MediaPreviewPopover>{typeof content === "function" ? content(active) : content}</MediaPreviewPopover>
      )}
    </div>
  );
}
