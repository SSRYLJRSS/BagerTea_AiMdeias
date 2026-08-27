/**
 * ViewerInfoSidebar（指导书 §2.3/§4.1）：查看器左属性栏。
 *  文件信息 · 通用属性 · 图片/视频属性（AssetInfoPanel）· 标签。
 *  内容长时只在左栏滚动，不遮挡媒体舞台。
 */
import AssetInfoPanel from "@/components/library/AssetInfoPanel";
import TagChip from "@/components/library/TagChip";
import type { Asset } from "@/types/asset";
import type { Tag } from "@/types/tag";

interface ViewerInfoSidebarProps {
  asset: Asset;
  tags: Tag[];
  onRemoveTag: (tagId: number) => void;
  onAddTag: () => void;
  onRefreshed: (asset: Asset) => void;
}

export default function ViewerInfoSidebar({ asset, tags, onRemoveTag, onAddTag, onRefreshed }: ViewerInfoSidebarProps) {
  return (
    <div className="flex flex-col gap-4">
      {/* 标签 */}
      <section>
        <h4 className="mb-1.5 text-[10px] font-medium tracking-wide text-[var(--color-text-secondary)] uppercase">标签</h4>
        <div className="flex flex-wrap items-center gap-1.5">
          {tags.map((t) => (
            <TagChip key={t.id} label={t.name} onRemove={() => onRemoveTag(t.id)} />
          ))}
          {tags.length === 0 && <span className="text-xs text-[var(--color-text-secondary)]">未打标</span>}
        </div>
        <button
          type="button"
          onClick={onAddTag}
          className="mt-2 rounded-md border border-dashed border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
        >
          + 添加标签
        </button>
      </section>

      {/* 属性（通用/图片/视频分组） */}
      <section>
        <h4 className="mb-1.5 text-[10px] font-medium tracking-wide text-[var(--color-text-secondary)] uppercase">属性</h4>
        <AssetInfoPanel asset={asset} onRefreshed={onRefreshed} />
      </section>
    </div>
  );
}