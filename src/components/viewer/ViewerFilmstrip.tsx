/**
 * ViewerFilmstrip（指导书 §2.3/§4.1）：底部胶片条。
 *  上一张/下一张（ChevronLeft/Right）· 缩略图流 · 当前位置。
 *  使用 isVideoAsset 同源判断视频/图片占位文字。
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

export default function ViewerFilmstrip({ items, currentId, onJump, onPrev, onNext }: ViewerFilmstripProps) {
  return (
    <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-t border-[var(--color-border)] px-2 py-2">
      <button
        type="button"
        onClick={onPrev}
        aria-label="上一张"
        title="上一张（←）"
        className="flex size-9 shrink-0 items-center justify-center rounded-md text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] disabled:opacity-30"
        disabled={items.length === 0}
      >
        <ChevronLeft size={18} strokeWidth={2} aria-hidden="true" />
      </button>

      <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto">
        {items.map((a, i) => (
          <button
            key={a.id}
            type="button"
            onClick={() => onJump(i)}
            aria-label={`第 ${i + 1} 张：${a.fileName}`}
            className={clsx(
              "h-14 w-14 shrink-0 overflow-hidden rounded border-2 transition-all",
              a.id === currentId
                ? "border-[var(--color-accent)]"
                : "border-transparent opacity-70 hover:opacity-100",
            )}
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
        className="flex size-9 shrink-0 items-center justify-center rounded-md text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] disabled:opacity-30"
        disabled={items.length === 0}
      >
        <ChevronRight size={18} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}