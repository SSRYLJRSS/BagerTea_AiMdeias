/**
 * StageFrame（FB2-04/05）：Viewer 媒体舞台的唯一尺寸容器。
 * 图片与视频共用同一容器，保证两者的可视区域、控制条位置像素级一致。
 * 用 padding（p-4）而非百分比约束——百分比 max-height 在父级 auto 时解析为 none（历史 bug），
 * 且 82% 这个数字与控制条实际高度无关，控制条高度变化时不会跟随。
 */
import type { ReactNode, Ref } from "react";
import clsx from "clsx";

interface StageFrameProps {
  children: ReactNode;
  stageRef?: Ref<HTMLDivElement>;
  className?: string;
  /** 交互事件（图片分支挂 pointer / contextmenu；视频分支不挂） */
  handlers?: React.DOMAttributes<HTMLDivElement>;
  style?: React.CSSProperties;
}

export default function StageFrame({ children, stageRef, className, handlers, style }: StageFrameProps) {
  return (
    <div
      ref={stageRef}
      data-media-stage
      data-testid="media-viewport"
      className={clsx(
        "relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden bg-[var(--color-bg)] p-4",
        className,
      )}
      style={style}
      {...handlers}
    >
      {children}
    </div>
  );
}