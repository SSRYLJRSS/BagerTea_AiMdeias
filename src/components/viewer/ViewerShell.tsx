/**
 * ViewerShell（指导书 §2.3/§4.1 + FB3-04 §6.2 + FB5-01 §4.2）：查看器布局骨架。
 *  工具条（固定） → 左属性栏 + 右媒体舞台（纵向 flex，舞台 flex-1 min-h-0） → 底部胶片条。
 *  标题栏在查看器外层始终可见（查看器不再 fixed inset-0 覆盖标题栏）。
 *  FB3-04：全屏浏览模式 —— 只保留工具条与媒体舞台；属性栏/标签区/胶片条整体 display:none。
 *  FB5-01（§4.2）：沉浸分支从结构上卸载 toolbar/sidebar/tagBar/filmstrip，只返回 stage；
 *  背景色由 StageFrame 的 surface 变体决定（图片白底、视频黑底），不在 Shell 层写死黑色。
 */
import type { ReactNode } from "react";

interface ViewerShellProps {
  /** FB5-01：沉浸浏览（图片白底/视频黑底，只剩媒体舞台） */
  immersive: boolean;
  toolbar: ReactNode;
  /** 左侧属性栏（260–300px）；沉浸时整体隐藏 */
  sidebar: ReactNode;
  /** 右侧媒体舞台 */
  stage: ReactNode;
  /** FB2-04：舞台下方的标签区（固定高，可折叠）。null 时不占位。沉浸时整体隐藏。 */
  tagBar?: ReactNode;
  /** 底部胶片条；沉浸时整体隐藏 */
  filmstrip: ReactNode;
}

export default function ViewerShell({ immersive, toolbar, sidebar, stage, tagBar, filmstrip }: ViewerShellProps) {
  if (immersive) {
    return (
      <div data-viewer-immersive className="flex h-full min-h-0 flex-col">
        <div className="flex min-h-0 min-w-0 flex-1">{stage}</div>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-bg)]">
      {toolbar}
      <div className="flex min-h-0 flex-1">
        {sidebar && (
          <aside className="w-[280px] shrink-0 overflow-y-auto border-r border-[var(--color-border)] p-3">
            {sidebar}
          </aside>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {stage}
          {tagBar}
        </div>
      </div>
      {filmstrip}
    </div>
  );
}
