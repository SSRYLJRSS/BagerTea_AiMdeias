/** 网格卡片：缩略图 + 选中态 + 视频时长角标 + 文件名 */
import { memo, useCallback } from "react";
import clsx from "clsx";
import Thumbnail from "./Thumbnail";
import type { Asset } from "@/types/asset";

interface AssetCardProps {
  asset: Asset;
  index: number;
  selected: boolean;
  onSelect: (asset: Asset, index: number, e: React.MouseEvent) => void;
  onPreview: (asset: Asset) => void;
  onContextMenu: (asset: Asset, index: number, e: React.MouseEvent) => void;
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export default memo(function AssetCard({ asset, index, selected, onSelect, onPreview, onContextMenu }: AssetCardProps) {
  const handleClick = useCallback(
    (e: React.MouseEvent) => onSelect(asset, index, e),
    [asset, index, onSelect],
  );
  const handleDoubleClick = useCallback(() => onPreview(asset), [asset, onPreview]);
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => onContextMenu(asset, index, e),
    [asset, index, onContextMenu],
  );

  const isVideo = asset.durationMs != null;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-selected={selected}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      className={clsx(
        "group relative aspect-square cursor-pointer overflow-hidden rounded-md outline-none select-none",
        "ring-offset-2 ring-offset-[var(--color-bg)] transition-shadow",
        selected ? "ring-2 ring-[var(--color-accent)]" : "hover:ring-1 hover:ring-[var(--color-border)]",
      )}
    >
      <Thumbnail assetId={asset.id} placeholderPath={asset.placeholderPath} alt={asset.fileName} />

      {/* 视频角标 */}
      {isVideo && (
        <span className="absolute right-1 bottom-1 rounded bg-black/60 px-1 text-[10px] leading-4 text-white">
          {formatDuration(asset.durationMs!)}
        </span>
      )}

      {/* 选中勾选 */}
      {selected && (
        <span className="absolute top-1 left-1 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--color-accent)] text-[10px] text-[var(--color-accent-text)]">
          ✓
        </span>
      )}

      {/* hover 文件名 */}
      <div className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/60 to-transparent px-1.5 pt-4 pb-1 text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100">
        {asset.fileName}
      </div>
    </div>
  );
});
