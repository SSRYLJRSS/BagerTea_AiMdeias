/**
 * ViewerFilmstrip（指导书 §2.3/§4.1 + FB3-02 §4.2）：底部胶片条 —— 固定高度的两行缩略图带。
 *  外层固定 128px（两行 56px 缩略图 + gap + 内边距）；内层 grid：
 *  grid-template-rows: repeat(2, minmax(0,1fr))、grid-auto-flow: column、固定 grid-auto-columns。
 *  两行填满当前宽度；超出只横向滚动（overflow-x:auto + overflow-y:hidden，无纵向滚动）。
 *  上一张/下一张按钮固定左右；缩略图区 min-w-0 防按钮挤压网格。
 *  点击缩略图、左右按钮、键盘左右键都定位同一素材（onJump/onPrev/onNext 由上层绑定）。
 *  「双排」指缩略图胶片条；标签区 ViewerTagBar 是独立组件，两者代码与文案不混用。
 */
import clsx from "clsx";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { isVideoAsset } from "@/utils/assetKind";
import type { Asset } from "@/types/asset";

interface ViewerFilmstripProps {
  items: Asset[];
  currentId: number;
  onJump: (index: number) => void;
  onPrev: () => void;
  onNext: () => void;
}

/** FB3-02：缩略图固定 56px（双行带）；grid-auto-columns 与之一致 */
const THUMB = 56;

export default function ViewerFilmstrip({ items, currentId, onJump, onPrev, onNext }: ViewerFilmstripProps) {
  return (
    <div
      data-filmstrip
      className="flex h-32 shrink-0 items-stretch gap-1.5 border-t border-[var(--color-border)] px-2 py-2"
    >
      <button
        type="button"
        onClick={onPrev}
        aria-label="上一张"
        title="上一张（←）"
        className="flex size-9 shrink-0 items-center justify-center self-center rounded-md text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] disabled:opacity-30"
        disabled={items.length === 0}
      >
        <ChevronLeft size={18} strokeWidth={2} aria-hidden="true" />
      </button>

      {/* 两行缩略图网格：只横向滚动，无纵向滚动（FB3-02 验收语义） */}
      <div
        className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
        style={{
          display: "grid",
          gridTemplateRows: "repeat(2, minmax(0, 1fr))",
          gridAutoFlow: "column",
          gridAutoColumns: `${THUMB}px`,
          gap: "4px",
          alignContent: "stretch",
        }}
      >
        {items.map((a, i) => (
          <button
            key={a.id}
            type="button"
            onClick={() => onJump(i)}
            aria-label={`第 ${i + 1} 张：${a.fileName}`}
            className={clsx(
              "h-full w-full shrink-0 overflow-hidden rounded border-2 transition-all",
              a.id === currentId
                ? "border-[var(--color-accent)]"
                : "border-transparent opacity-70 hover:opacity-100",
            )}
            style={{ width: THUMB }}
          >
            {a.placeholderPath ? (
              <img src={convertFileSrc(a.placeholderPath)} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="flex h-full w-full items-center justify-center bg-[var(--color-surface)] text-[9px] text-[var(--color-text-secondary)]">
                {isVideoAsset(a) ? "视频" : "图片"}
              </span>
            )}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={onNext}
        aria-label="下一张"
        title="下一张（→）"
        className="flex size-9 shrink-0 items-center justify-center self-center rounded-md text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] disabled:opacity-30"
        disabled={items.length === 0}
      >
        <ChevronRight size={18} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}
