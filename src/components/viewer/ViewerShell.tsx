/**
 * ViewerShell（指导书 §2.3/§4.1）：查看器布局骨架。
 *  工具条（固定） → 左属性栏 + 右媒体舞台（纵向 flex，舞台 flex-1 min-h-0） → 底部胶片条。
 *  标题栏在查看器外层始终可见（查看器不再 fixed inset-0 覆盖标题栏）。
 */
import type { ReactNode } from "react";

interface ViewerShellProps {
  toolbar: ReactNode;
  /** 左侧属性栏（260–300px） */
  sidebar: ReactNode;
  /** 右侧媒体舞台 */
  stage: ReactNode;
  /** FB2-04：舞台下方的标签区（固定高，可折叠）。null 时不占位。 */
  tagBar?: ReactNode;
  /** 底部胶片条 */
  filmstrip: ReactNode;
}

export default function ViewerShell({ toolbar, sidebar, stage, tagBar, filmstrip }: ViewerShellProps) {
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