/** 素材库网格（P2.4）：薄封装 AssetGridView，数据源绑定 libraryStore。 */
import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import AssetGridView, { type LibraryGridActions } from "./AssetGridView";
import type { PaletteSegment } from "./ColorStrip";
import { useLibraryStore } from "@/stores/libraryStore";
import { dominantFiltersFor } from "@/utils/dominantFilter";
import type { Asset } from "@/types/asset";

export type { LibraryGridActions };
export interface LibraryActions extends LibraryGridActions {
  onDedup?: () => void;
}

interface AssetGridProps extends LibraryActions {
  onPreview: (asset: Asset) => void;
}

export default function AssetGrid({ onPreview, onAiTag, onAssignTags, onExport, onMove, onDelete }: AssetGridProps) {
  const { items, total, loading, loadMore, fetchAllIds, filter, setFilter } = useLibraryStore(
    useShallow((s) => ({
      items: s.items,
      total: s.total,
      loading: s.loading,
      loadMore: s.loadMore,
      fetchAllIds: s.fetchAllIds,
      filter: s.filter,
      setFilter: s.setFilter,
    })),
  );

  // FB2-08（§14.9）：点主色段 → 构造同色系条件写入筛选器并刷新列表（与分面点击交互一致，不弹对话框）。
  const onSearchDominant = useCallback(
    (seg: PaletteSegment) => {
      const next = dominantFiltersFor(seg);
      const keys = new Set(next.map((f) => f.key));
      // 同 key 的旧条件必须替换而不是叠加：两个不相交的 hue 区间 AND 起来恒为空集。
      // untaggedOnly / trashOnly 一并复位，与 MetadataPanel 的分面点击语义一致。
      setFilter({
        metadataFilters: [...(filter.metadataFilters ?? []).filter((f) => !keys.has(f.key)), ...next],
        untaggedOnly: false,
        trashOnly: false,
      });
    },
    [filter.metadataFilters, setFilter],
  );

  return (
    <AssetGridView
      items={items}
      total={total}
      loading={loading}
      loadMore={loadMore}
      fetchAllIds={fetchAllIds}
      onPreview={onPreview}
      onAiTag={onAiTag}
      onAssignTags={onAssignTags}
      onExport={onExport}
      onMove={onMove}
      onDelete={onDelete}
      scrollRestoreKey="library"
      onSearchDominant={onSearchDominant}
    />
  );
}
