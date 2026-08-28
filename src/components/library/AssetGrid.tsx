/** 素材库网格（P2.4）：薄封装 AssetGridView，数据源绑定 libraryStore。 */
import { useShallow } from "zustand/react/shallow";
import AssetGridView, { type LibraryGridActions } from "./AssetGridView";
import { useLibraryStore } from "@/stores/libraryStore";
import type { Asset } from "@/types/asset";

export type { LibraryGridActions };
export interface LibraryActions extends LibraryGridActions {
  onDedup?: () => void;
}

interface AssetGridProps extends LibraryActions {
  onPreview: (asset: Asset) => void;
}

export default function AssetGrid({ onPreview, onAiTag, onAssignTags, onExport, onMove, onDelete }: AssetGridProps) {
  const { items, total, loading, loadMore, fetchAllIds } = useLibraryStore(
    useShallow((s) => ({
      items: s.items,
      total: s.total,
      loading: s.loading,
      loadMore: s.loadMore,
      fetchAllIds: s.fetchAllIds,
    })),
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
    />
  );
}
