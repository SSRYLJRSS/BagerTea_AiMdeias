/** 极简网格：@tanstack/react-virtual 行虚拟化，3 万素材流畅滚动（PRD 5.3）
 *  v2.8：单击取消选中；接管右键（全选/反选/复制路径/打开所在文件夹等） */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import { useShallow } from "zustand/react/shallow";
import AssetCard from "./AssetCard";
import ContextMenu, { type MenuEntry } from "@/components/common/ContextMenu";
import { getAssetUrls } from "@/api/assets";
import { useElementSize, useEscape } from "@/hooks/hooks";
import { useLibraryStore } from "@/stores/libraryStore";
import { useSelectionStore } from "@/stores/selectionStore";
import type { Asset } from "@/types/asset";

/** 素材库批量操作入口（顶栏与右键菜单共用） */
export interface LibraryActions {
  onAiTag: () => void;
  onAssignTags: () => void;
  onExport: () => void;
  onDelete: () => void;
}

const GAP = 8;
const MIN_CARD = 160; // 卡片最小边长，列数自适应

interface AssetGridProps extends LibraryActions {
  onPreview: (asset: Asset) => void;
}

export default function AssetGrid({ onPreview, onAiTag, onAssignTags, onExport, onDelete }: AssetGridProps) {
  const { items, total, loadMore, fetchAllIds } = useLibraryStore(
    useShallow((s) => ({ items: s.items, total: s.total, loadMore: s.loadMore, fetchAllIds: s.fetchAllIds })),
  );
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

  const columns = Math.max(2, Math.floor((width + GAP) / (MIN_CARD + GAP)));
  const rowCount = Math.ceil(items.length / columns);
  const orderedIds = useMemo(() => items.map((a) => a.id), [items]);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => ref.current,
    estimateSize: () => (width - GAP * (columns - 1)) / columns + GAP,
    overscan: 3,
  });

  // 滚动近底部加载下一页
  useEffect(() => {
    const last = virtualizer.getVirtualItems().at(-1);
    if (last && last.index >= rowCount - 2 && items.length < total) void loadMore();
  }, [virtualizer.getVirtualItems(), rowCount, items.length, total, loadMore]);

  // 空白处点击 / Esc 取消选中（PRD 5.4-2）
  useEscape(useCallback(() => clear(), [clear]), selected.size > 0);

  // Ctrl+A 全选 / Ctrl+I 反选（竞品标准交互）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
  }, [fetchAllIds, setAll, invert]);

  const handleSelect = useCallback(
    (asset: Asset, index: number, e: React.MouseEvent) => {
      if (e.shiftKey) {
        rangeTo(index, orderedIds);
      } else if (e.ctrlKey || e.metaKey) {
        toggle(asset.id, index, true);
      } else if (selected.size === 1 && selected.has(asset.id)) {
        clear(); // 单击已独占选中的项 → 取消选择（v2.8）
      } else {
        toggle(asset.id, index, false);
      }
    },
    [toggle, rangeTo, orderedIds, selected, clear],
  );

  // ---- 右键菜单（v2.8） ----
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const handleContextMenu = useCallback(
    (asset: Asset, _index: number, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // 右键未选中项 → 先独占选中它（Eagle/资源管理器惯例）
      if (!selected.has(asset.id)) toggle(asset.id, _index, false);
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
    if (paths[0]) await invoke("reveal_in_folder", { path: paths[0] });
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
      { label: "删除", onClick: onDelete },
      { divider: true },
      { label: "复制路径", onClick: () => void copyPaths() },
      { label: "打开所在文件夹", disabled: selected.size !== 1, onClick: () => void revealFirst() },
      { divider: true },
      ...common,
      { label: "取消选择", onClick: clear },
    ];
  }, [selected.size, fetchAllIds, setAll, invert, onAiTag, onAssignTags, onExport, onDelete, copyPaths, revealFirst, clear]);

  if (items.length === 0) {
    return (
      <div ref={ref} className="flex h-full flex-1 items-center justify-center text-sm text-[var(--color-text-secondary)]">
        {total === 0 ? "还没有素材，去「入库」拖一些进来吧" : "没有匹配的素材"}
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
              if (!asset) return <div key={c} />;
              return (
                <AssetCard
                  key={asset.id}
                  asset={asset}
                  index={idx}
                  selected={selected.has(asset.id)}
                  onSelect={handleSelect}
                  onPreview={onPreview}
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
