/** 超级搜索页（P4 + §12 FB-06 / FB2-06）：搜索优先——中央大搜索框 + 布尔条件公式构建器 + 结果网格。
 *  FB2-06（§7.2 方案 A）：把「可折叠头部」移出滚动容器——折叠只改 header 高度，不再改变滚动容器
 *  scrollHeight，从根上断掉「卸载 ↔ scrollHeight 钳制」的正反馈环（原先的闪烁根因）。
 *  结构：顶栏（固定）→ header 区（shrink-0 不滚动，含摘要条 + grid-template-rows 折叠的详细条件）
 *  → 滚动容器（只装虚拟化网格）。
 */
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

  // FB2-06（§7.3 方案 C）：非对称阈值 + 顶部区恒展开 + 手动设定抑制窗
  const [chrome, setNode, setChrome] = useScrollDirection({
    collapseThreshold: 24,
    expandThreshold: 12,
    minScrollTop: 48,
    suppressMs: 300,
  });
  const scrollRef = useRef<HTMLElement | null>(null);

  const bindScroll = useCallback(
    (el: HTMLElement | null) => {
      scrollRef.current = el;
      setNode(el);
    },
    [setNode],
  );

  // §7.5 方案 E：仅命中筛选区才强制展开（点结果卡片不展开、不跳动）
  const forceExpand: React.FocusEventHandler = (e) => {
    if (!(e.target as HTMLElement).closest?.("[data-filter-zone]")) return;
    if (chrome !== "expanded") setChrome("expanded");
  };

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
      {/* 顶栏：返回 + 结果数（固定，不滚动） */}
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

      {/* header 区（shrink-0，不滚动）：摘要条 + 可折叠详细条件。
          折叠只改 header 高度，不再改变滚动容器的 scrollHeight（FB2-06 方案 A） */}
      <div
        data-filter-zone
        onFocusCapture={forceExpand}
        className="shrink-0"
      >
        {/* 摘要条：搜索框 + chips + 计数 + 常驻展开/收起开关（移出滚动容器后为普通块级） */}
        <div className="border-b border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3">
          <div className="mx-auto max-w-5xl">
            <AiSearchBar onSubmit={(text) => void applyAiSearch(text)} />
            <div className="mt-1.5 flex items-center gap-2">
              <FilterChips />
              <span className="ml-auto shrink-0 text-[11px] text-[var(--color-text-tertiary)]">{total} 项</span>
              <button
                type="button"
                onClick={() => setChrome(chrome === "expanded" ? "collapsed" : "expanded")}
                aria-expanded={chrome === "expanded"}
                aria-controls="super-search-filters"
                className="shrink-0 rounded px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text)] focus-visible:ring-1 focus-visible:ring-[var(--color-status)]"
              >
                {chrome === "expanded" ? "收起 ⤴" : "展开详细条件 ⤵"}
              </button>
            </div>
          </div>
        </div>

        {/* 详细条件面板：始终在 DOM，用 grid-template-rows 0fr↔1fr 折叠（§3.5 禁动画 height） */}
        <div
          id="super-search-filters"
          className="grid transition-[grid-template-rows] duration-200 ease-out"
          style={{ gridTemplateRows: chrome === "expanded" ? "1fr" : "0fr" }}
          aria-hidden={chrome !== "expanded"}
        >
          <div
            className="overflow-hidden"
            style={chrome !== "expanded" ? { pointerEvents: "none" } : undefined}
          >
            <div className="mx-auto max-w-5xl px-4 pt-3 pb-2">
              <QueryBuilder />
            </div>
          </div>
        </div>
      </div>

      {/* 滚动容器：只装虚拟化网格（FB2-06 唯一滚动上下文） */}
      <div ref={bindScroll} data-testid="super-search-scroll" className="min-h-0 flex-1 overflow-y-auto">
        <AssetGridView
          items={items}
          total={total}
          loading={loading}
          loadMore={loadMore}
          fetchAllIds={fetchAllIds}
          onPreview={setPreview}
          scrollElementRef={scrollRef}
          scrollRestoreKey="superSearch"
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