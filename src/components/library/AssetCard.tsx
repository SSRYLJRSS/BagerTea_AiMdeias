/** 网格卡片（指导书 §2.2/§6.1）：缩略图 + 角标 + 选中态 + 文件名 + 单击/双击/右键。
 *  素材库禁止大图/视频 hover 预览：不创建 <video>、不请求 1024px hover 图、
 *  不渲染 fixed 大图浮层；hover 只允许边框/文件名透明度变化（§3.3）。双击进入 Viewer。 */
import { memo, useCallback } from "react";
import clsx from "clsx";
import Thumbnail from "./Thumbnail";
import { isVideoAsset } from "@/utils/assetKind";
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

/** RAW 系扩展名（与后端 mime.rs is_raw_ext 同源） */
const RAW_EXTS = new Set([
  "raw", "cr2", "cr3", "crw", "nef", "nrw", "arw", "srf", "sr2", "dng",
  "raf", "orf", "rw2", "pef", "srw", "x3f", "mrw", "iiq", "3fr", "fff",
  "kdc", "dcr", "mos", "mef", "erf",
]);

/** 格式角标（Phase 2 F05）：RAW/TIFF/HEIC 特殊格式标注，常见格式不打扰 */
function formatBadge(ext: string): string | null {
  const e = ext.toLowerCase();
  if (e === "tif" || e === "tiff") return "TIFF";
  if (e === "heic" || e === "heif") return "HEIC";
  if (RAW_EXTS.has(e)) return "RAW";
  return null;
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

  // B-4：视频类型统一按 MIME 判断（导入时长读取失败时 durationMs 为 null 也能识别为视频）
  const isVideo = isVideoAsset(asset);
  const badge = formatBadge(asset.fileExt);

  return (
    <div className="relative">
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

        {/* 视频角标（时长缺失时仅按视频识别，不显示时长数字） */}
        {isVideo && asset.durationMs != null && (
          <span className="absolute right-1 bottom-1 rounded bg-black/60 px-1 text-[10px] leading-4 text-white">
            {formatDuration(asset.durationMs)}
          </span>
        )}

        {/* 格式角标（RAW/TIFF/HEIC） */}
        {badge && (
          <span className="absolute right-1 top-1 rounded bg-black/60 px-1 text-[10px] leading-4 text-white">
            {badge}
          </span>
        )}

        {/* 选中勾选 */}
        {selected && (
          <span className="absolute top-1 left-1 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--color-accent)] text-[10px] text-[var(--color-accent-text)]">
            ✓
          </span>
        )}

        {/* hover 文件名（§3.3：只允许透明度变化，不创建媒体层） */}
        <div className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/60 to-transparent px-1.5 pt-4 pb-1 text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100">
          {asset.fileName}
        </div>
      </div>
    </div>
  );
});