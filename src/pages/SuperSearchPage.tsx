/** 超级搜索页（P4 + §12 FB-06）：搜索优先——中央大搜索框 + 布尔条件公式构建器 + 结果网格。
 *  单主滚动容器：标题栏固定，sticky 摘要条（搜索框/chips/结果数），下滚收起详细条件、上滚恢复，
 *  只动画 transform/opacity（§12.2）；复用 AssetGridView（通用网格）+ 全局选中/批量操作。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import AiSearchBar from "@/components/supersearch/AiSearchBar";
import QueryBuilder from "@/components/supersearch/QueryBuilder";
import FilterChips from "@/components/supersearch/FilterChips";
import AssetGridView from "@/components/library/AssetGridView";
import DeleteDialog from "@/components/dialogs/DeleteDialog";
import ExportDialog from "@/components/dialogs/ExportDialog";
import TagAssignDialog from "@/components/dialogs/TagAssignDialog";
import ViewerPage from "@/components/library/ViewerPage";
import { useScrollDirection } from "@/hooks/useScrollDirection";
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

  // §5 FB-12：单主滚动容器 + 方向收缩
  const scrollRef = useRef<HTMLElement | null>(null);
  const [chrome, setChromeNode, setChrome] = useScrollDirection({ threshold: 15 });
  // 底部 QuickEdit 抽屉：打开时强制展开条件并阻止布局重排
  const [quickEdit, setQuickEdit] = useState(false);

  const bindScroll = useCallback(
    (el: HTMLElement | null) => {
      scrollRef.current = el;
      setChromeNode(el);
    },
    [setChromeNode],
  );

  const forceExpand: React.FocusEventHandler = () => {
    if (chrome !== "expanded") setChrome("expanded");
  };

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (quickEdit) setChrome("expanded");
  }, [quickEdit, setChrome]);

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

      {/* 单主滚动容器（§12 FB-06）：sticky 摘要条 + 可收起详情条件 + 虚拟化网格 */}
      <div
        ref={bindScroll}
        data-testid="super-search-scroll"
        className="min-h-0 flex-1 overflow-y-auto"
        onFocusCapture={forceExpand}
      >
        {/* sticky 摘要条：搜索框 + chips + 结果数；常驻 */}
        <div className="sticky top-0 z-10 border-b border-[var(--color-border)] bg-[var(--color-bg)]/95 px-4 py-3 backdrop-blur">
          <div className="mx-auto max-w-5xl">
            <AiSearchBar onSubmit={(text) => void applyAiSearch(text)} />
            <div className="mt-1.5 flex items-center gap-2">
              <FilterChips />
              <span className="ml-auto shrink-0 text-[11px] text-[var(--color-text-tertiary)]">{total} 项</span>
            </div>
            {/* 收起提示（仅收起时可见） */}
            {chrome === "collapsed" && (
              <button
                type="button"
                onClick={() => setChrome("expanded")}
                className="mt-1 shrink-0 rounded px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
                aria-label="展开详细条件"
              >
                ⤵ 展开详细条件
              </button>
            )}
          </div>
        </div>

        {/* 详细条件面板：下滚收起、上滚恢复；收起占位不挤占结果区（§12.2） */}
        {chrome === "expanded" && (
          <div className="px-4 pt-3">
            <div className="mx-auto max-w-5xl">
              <QueryBuilder />
            </div>
          </div>
        )}

        {/* 虚拟化网格：与上方共用同一滚动容器 */}
        <AssetGridView
          items={items}
          total={total}
          loading={loading}
          loadMore={loadMore}
          fetchAllIds={fetchAllIds}
          onPreview={setPreview}
          scrollElementRef={scrollRef}
          {...actions}
        />

        {/* 底部编辑条（§12.3）：常驻，打开抽屉快速编辑，背景不重排 */}
        <button
          type="button"
          onClick={() => setQuickEdit(true)}
          className="sticky bottom-2 z-10 mx-auto block rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-1.5 text-xs text-[var(--color-text-secondary)] shadow hover:text-[var(--color-text)]"
        >
          快速编辑条件
        </button>
      </div>

      {/* QuickEdit 抽屉：打开时条件强制展开（不重排背景结果） */}
      {quickEdit && (
        <div className="absolute inset-x-0 bottom-0 z-20 border-t border-[var(--color-border)] bg-[var(--color-bg)] shadow-lg">
          <div className="flex items-center justify-between px-4 py-2">
            <span className="text-xs font-semibold text-[var(--color-text)]">快速编辑条件</span>
            <button
              type="button"
              onClick={() => setQuickEdit(false)}
              className="rounded px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)]"
              aria-label="关闭快速编辑"
            >
              完成
            </button>
          </div>
          <div className="max-h-[50vh] overflow-y-auto px-4 pb-4">
            <QueryBuilder />
          </div>
        </div>
      )}

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
