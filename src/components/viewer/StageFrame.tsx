/**
 * StageFrame（FB2-04/05）：Viewer 媒体舞台的唯一尺寸容器。
 * 图片与视频共用同一容器，保证两者的可视区域、控制条位置像素级一致。
 * 用 padding（p-4）而非百分比约束——百分比 max-height 在父级 auto 时解析为 none（历史 bug），
 * 且 82% 这个数字与控制条实际高度无关，控制条高度变化时不会跟随。
 *
 * FB5-01（§3.2）：surface 决定背景与留白 ——
 *  - app：主题背景 + 16px 留白（普通查看）；
 *  - image-immersive：固定纯白（#fff，不随深色主题变黑）+ 桌面 24px / 窄窗口 12px 留白；
 *  - video-immersive：固定纯黑 + 0 留白（视频铺满）。
 */
import type { ReactNode, Ref } from "react";
import clsx from "clsx";

export type StageSurface = "app" | "image-immersive" | "video-immersive";

const SURFACE_CLASS: Record<StageSurface, string> = {
  app: "bg-[var(--color-bg)] p-4",
  "image-immersive": "bg-[#ffffff] p-3 sm:p-6",
  "video-immersive": "bg-[#000000] p-0",
};

interface StageFrameProps {
  children: ReactNode;
  stageRef?: Ref<HTMLDivElement>;
  className?: string;
  /** 交互事件（图片分支挂 pointer / contextmenu；视频分支不挂） */
  handlers?: React.DOMAttributes<HTMLDivElement>;
  style?: React.CSSProperties;
  /** FB5-01：舞台表面变体（默认 app） */
  surface?: StageSurface;
}

export default function StageFrame({ children, stageRef, className, handlers, style, surface = "app" }: StageFrameProps) {
  return (
    <div
      ref={stageRef}
      data-media-stage
      data-surface={surface}
      data-testid="media-viewport"
      className={clsx(
        "relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden",
        SURFACE_CLASS[surface],
        className,
      )}
      style={style}
      {...handlers}
    >
      {children}
    </div>
  );
}
