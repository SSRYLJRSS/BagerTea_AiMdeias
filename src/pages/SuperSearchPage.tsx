/** 超级搜索页（P4）：搜索优先——中央大搜索框 + 布尔条件公式构建器 + 结果网格。
 *  复用 AssetGridView（通用网格）+ 全局选中/批量操作。AI 输入回填构建器。 */
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import AiSearchBar from "@/components/supersearch/AiSearchBar";
import QueryBuilder from "@/components/supersearch/QueryBuilder";
import AssetGridView from "@/components/library/AssetGridView";
import DeleteDialog from "@/components/dialogs/DeleteDialog";
import ExportDialog from "@/components/dialogs/ExportDialog";
import TagAssignDialog from "@/components/dialogs/TagAssignDialog";
import ViewerPage from "@/components/library/ViewerPage";
import { useSuperSearchStore } from "@/stores/superSearchStore";
import { useSelectionStore } from "@/stores/selectionStore";
import { useAiStore } from "@/stores/aiStore";
import type { Asset } from "@/types/asset";

type DialogKey = "delete" | "export" | "tags" | null;

export default function SuperSearchPage({ onBack }: { onBack: () => void }) {
  const { refresh, error, total, loading, items, loadMore, fetchAllIds, applyAiSearch } = useSuperSearchStore(
    useShallow((s) => ({
      refresh: s.refresh,
      error: s.error,
      total: s.total,
      loading: s.loading,
      items: s.items,
      loadMore: s.loadMore,
      fetchAllIds: s.fetchAllIds,
      applyAiSearch: s.applyAiSearch,
    })),
  );
  const selected = useSelectionStore((s) => s.selected);
  const [dialog, setDialog] = useState<DialogKey>(null);
  const [exportMode, setExportMode] = useState<"copy" | "move">("copy");
  const [preview, setPreview] = useState<Asset | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (dialog === "export" && selected.size === 0) setDialog(null);
  }, [dialog, selected.size]);

  const actions = {
    onAiTag: () => {
      useAiStore.getState().setPendingAssets(Array.from(selected), "auto");
      window.dispatchEvent(new CustomEvent("app:navigate", { detail: "ai" }));
    },
    onAssignTags: () => {
      useAiStore.getState().setPendingAssets(Array.from(selected), "manual");
      window.dispatchEvent(new CustomEvent("app:navigate", { detail: "ai" }));
    },
    onExport: () => {
      setExportMode("copy");
      setDialog("export");
    },
    onMove: () => {
      setExportMode("move");
      setDialog("export");
    },
    onDelete: () => setDialog("delete"),
  };

  return (
    <div className="relative flex h-full flex-col">
      {/* 顶栏：返回 + 结果数 */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3">
        <button
          onClick={onBack}
          className="shrink-0 rounded px-2 py-1 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
        >
          ← 返回
        </button>
        <h1 className="shrink-0 text-sm font-semibold tracking-wide text-[var(--color-text)]">超级搜索</h1>
        <span className="ml-auto shrink-0 text-xs text-[var(--color-text-secondary)]">{total} 项</span>
      </div>

      <div className="shrink-0 border-b border-[var(--color-border)] px-4 py-4">
        <div className="mx-auto max-w-5xl">
          <AiSearchBar onSubmit={(text) => void applyAiSearch(text)} />
          <div className="mt-4"><QueryBuilder /></div>
        </div>
      </div>

      {/* 结果网格 */}
      <div className="flex min-h-0 flex-1">
        <AssetGridView
          items={items}
          total={total}
          loading={loading}
          loadMore={loadMore}
          fetchAllIds={fetchAllIds}
          onPreview={setPreview}
          {...actions}
        />
      </div>

      {error && (
        <div className="absolute right-3 bottom-3 rounded-md bg-[var(--color-danger)] px-3 py-2 text-xs text-white shadow-lg">
          {error}
        </div>
      )}

      <DeleteDialog open={dialog === "delete"} onClose={() => setDialog(null)} />
      <ExportDialog open={dialog === "export" && selected.size > 0} initialMode={exportMode} onClose={() => setDialog(null)} />
      <TagAssignDialog open={dialog === "tags"} onClose={() => setDialog(null)} />
      {preview && <ViewerPage asset={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
