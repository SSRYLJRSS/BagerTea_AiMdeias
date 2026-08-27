/** 通用素材网格（P2.4）：受控组件，不 import useLibraryStore。
 *  虚拟滚动、选中/批量操作、右键菜单全部在此；AssetGrid 只是普通素材库的薄封装。 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useShallow } from "zustand/react/shallow";
import AssetCard from "./AssetCard";
import ContextMenu, { type MenuEntry } from "@/components/common/ContextMenu";
import { getAssetUrls, revealInFolder } from "@/api/assets";
import { useElementSize, useEscape } from "@/hooks/hooks";
import { useLibraryStore } from "@/stores/libraryStore";
import { useSelectionStore } from "@/stores/selectionStore";
import type { Asset } from "@/types/asset";

export interface AssetGridViewProps extends LibraryGridActions {
  items: Asset[];
  total: number;
  loading: boolean;
  loadMore: () => void;
  fetchAllIds: () => Promise<number[]>;
  onPreview: (asset: Asset) => void;
}

/** 批量操作入口（顶栏与右键菜单共用） */
export interface LibraryGridActions {
  onAiTag: () => void;
  onAssignTags: () => void;
  onExport: () => void;
  onMove: () => void;
  onDelete: () => void;
}

const GAP = 8;
const MIN_CARD = 160;

export default function AssetGridView({
  items,
  total,
  loading,
  loadMore,
  fetchAllIds,
  onPreview,
  onAiTag,
  onAssignTags,
  onExport,
  onMove,
  onDelete,
}: AssetGridViewProps) {
  const { selected, toggle, rangeTo, clear, setAll, invert } = useSelectionStore(
    useShallow((s) => ({
      selected: s.selected,
      toggle: s.toggle,
      rangeTo: s.rangeTo,
      clear: s.clear,
      setAll: s.setAll,
      invert: s.invert,
    })),
  );
  const { ref, width } = useElementSize<HTMLDivElement>();
  // §7.2：Viewer 关闭后恢复网格滚动位置（库页上下文保持；store 持有滚动量）
  useEffect(() => {
    const el = ref.current;
    const saved = useLibraryStore.getState().gridScrollTop;
    if (el && saved > 0) el.scrollTop = saved;
    // 仅挂载时恢复一次（Virtualizer 接管后续滚动）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 滚动位置写入 store（Viewer 打开前最后值；滚动容器卸载再恢复）
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        useLibraryStore.getState().setGridScrollTop(el.scrollTop);
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  const columns = Math.max(2, Math.floor((width + GAP) / (MIN_CARD + GAP)));
  const rowCount = Math.ceil(items.length / columns);
  const orderedIds = useMemo(() => items.map((a) => a.id), [items]);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => ref.current,
    estimateSize: () => (width - GAP * (columns - 1)) / columns + GAP,
    overscan: 3,
  });

  useEffect(() => {
    const last = virtualizer.getVirtualItems().at(-1);
    if (last && last.index >= rowCount - 2 && items.length < total) void loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualizer.range, rowCount, items.length, total, loadMore]);

  useEscape(useCallback(() => clear(), [clear]), selected.size > 0);

  const handleSelect = useCallback(
    (asset: Asset, index: number, e: React.MouseEvent) => {
      if (e.shiftKey) {
        rangeTo(index, orderedIds);
      } else {
        // E-1：普通点击/Ctrl/Command 都交给 store 决定添加或删除（additive toggle）。
        // 修复「普通点击已选素材不做任何事」的缺陷：已选再点即取消。
        toggle(asset.id, index, true);
      }
    },
    [toggle, rangeTo, orderedIds],
  );

  const handlePreview = useCallback((asset: Asset) => onPreview(asset), [onPreview]);

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (menu) return;
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === "a" || e.key === "A") {
        e.preventDefault();
        void fetchAllIds().then(setAll);
      } else if (e.key === "i" || e.key === "I") {
        e.preventDefault();
        void fetchAllIds().then(invert);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fetchAllIds, setAll, invert, menu]);

  const handleContextMenu = useCallback(
    (asset: Asset, _index: number, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!selected.has(asset.id)) toggle(asset.id, _index, true);
      setMenu({ x: e.clientX, y: e.clientY });
    },
    [selected, toggle],
  );

  const handleBlankContextMenu = useCallback((e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const copyPaths = useCallback(async () => {
    const paths = await getAssetUrls(Array.from(selected));
    await navigator.clipboard.writeText(paths.join("\n"));
  }, [selected]);

  const revealFirst = useCallback(async () => {
    const first = Array.from(selected)[0];
    if (first == null) return;
    const paths = await getAssetUrls([first]);
    if (paths[0]) await revealInFolder(paths[0]);
  }, [selected]);

  const menuEntries = useMemo((): MenuEntry[] => {
    const common: MenuEntry[] = [
      { label: "全选", onClick: () => void fetchAllIds().then(setAll) },
      { label: "反选", onClick: () => void fetchAllIds().then(invert) },
    ];
    if (selected.size === 0) return common;
    return [
      {
        label: "打标",
        children: [
          { label: "AI", onClick: onAiTag },
          { label: "手动", onClick: onAssignTags },
        ],
      },
      { label: "导出", onClick: onExport },
      { label: "移动到…", onClick: onMove },
      { label: "删除", onClick: onDelete },
      { divider: true },
      { label: "复制路径", onClick: () => void copyPaths() },
      { label: "打开所在文件夹", disabled: selected.size !== 1, onClick: () => void revealFirst() },
      { divider: true },
      ...common,
      { label: "取消选择", onClick: clear },
    ];
  }, [selected.size, fetchAllIds, setAll, invert, onAiTag, onAssignTags, onExport, onMove, onDelete, copyPaths, revealFirst, clear]);

  if (items.length === 0) {
    return (
      <div ref={ref} className="flex h-full flex-1 items-center justify-center text-sm text-[var(--color-text-secondary)]">
        {loading ? "加载中…" : total === 0 ? "没有符合条件的素材" : "没有匹配的素材"}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className="h-full min-w-0 flex-1 overflow-y-auto p-2"
      onClick={(e) => {
        if (e.target === e.currentTarget) clear();
      }}
      onContextMenu={handleBlankContextMenu}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((row) => (
          <div
            key={row.key}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${row.start}px)`,
              display: "grid",
              gridTemplateColumns: `repeat(${columns}, 1fr)`,
              gap: GAP,
              paddingBottom: GAP,
            }}
          >
            {Array.from({ length: columns }, (_, c) => {
              const idx = row.index * columns + c;
              const asset = items[idx];
              if (!asset) return <div key={`ph-${row.index}-${c}`} />;
              return (
                <AssetCard
                  key={asset.id}
                  asset={asset}
                  index={idx}
                  selected={selected.has(asset.id)}
                  onSelect={handleSelect}
                  onPreview={handlePreview}
                  onContextMenu={handleContextMenu}
                />
              );
            })}
          </div>
        ))}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menuEntries} onClose={() => setMenu(null)} />}
    </div>
  );
}
