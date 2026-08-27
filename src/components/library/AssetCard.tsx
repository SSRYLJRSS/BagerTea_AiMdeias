/** 网格卡片：缩略图 + 选中态 + 视频时长角标 + 格式角标 + 文件名（含 300ms 悬浮预览）
 *  F（指导书）：视频预览改为卡片内 overlay（覆盖原卡片，播放在原位置，离开即停）；
 *  图片预览继续使用固定 MediaPreviewPopover。均通过 useHoverIntent（300ms 进入延迟）驱动。 */
import { memo, useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { convertFileSrc } from "@tauri-apps/api/core";
import Thumbnail from "./Thumbnail";
import MediaPreviewPopover from "@/components/media/MediaPreviewPopover";
import ImagePreviewContent from "@/components/media/ImagePreviewContent";
import VideoHoverOverlay from "@/components/media/VideoHoverOverlay";
import { getImageHoverPreview } from "@/api/mediaPreview";
import { toFileUrl } from "@/api/thumbnail";
import { isVideoAsset } from "@/utils/assetKind";
import { useHoverIntent } from "@/hooks/useHoverIntent";
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

  // B-4：视频类型优先按 MIME 判断（导入时长读取失败时 durationMs 为 null 也能识别为视频）
  const isVideo = isVideoAsset(asset);
  // F：卡片自身持有 hover intent（300ms 进入），视频 overlay 与图片 popover 共享 active
  const { active, triggerProps } = useHoverIntent({});
  const badge = formatBadge(asset.fileExt);
  const cover = asset.placeholderPath ? toFileUrl(asset.placeholderPath) : null;

  return (
    <div {...triggerProps} className="relative">
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

        {/* hover 文件名 */}
        <div className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/60 to-transparent px-1.5 pt-4 pb-1 text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100">
          {asset.fileName}
        </div>

        {/* F：视频卡片内 overlay（hover active 时渲染，覆盖原卡片，播放失败回退封面） */}
        {isVideo && active && (
          <VideoHoverOverlay
            src={convertFileSrc(asset.filePath)}
            coverUrl={cover}
            fileName={asset.fileName}
          />
        )}
      </div>

      {/* F：图片继续用现有 MediaPreviewPopover（固定浮层） */}
      {!isVideo && active && (
        <MediaPreviewPopover>
          <ImageHoverContent asset={asset} />
        </MediaPreviewPopover>
      )}
    </div>
  );
});

/** 图片悬浮预览内容：按需取 1024px hover 预览（激活时请求，不在 render 中执行 IPC）。 */
function ImageHoverContent({ asset }: { asset: Asset }) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const cover = asset.placeholderPath ? toFileUrl(asset.placeholderPath) : null;
  useEffect(() => {
    let cancelled = false;
    void getImageHoverPreview(asset.id).then((u) => {
      if (!cancelled) setImgUrl(u);
    });
    return () => {
      cancelled = true;
    };
  }, [asset.id]);
  return <ImagePreviewContent url={imgUrl} placeholderUrl={cover} fileName={asset.fileName} />;
}
