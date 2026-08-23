/** 极简网格：@tanstack/react-virtual 行虚拟化，3 万素材流畅滚动（PRD 5.3）
 *  v2.8 演变（用户拍板，F19 2026-08-22）：
 *  - 普通单击 = 追加多选（点几张选几张）；单击已选中项保持不动（不再取消）；
 *  - Ctrl/⌘+单击 = 加选/减选切换；Shift+单击 = 锚点范围选；Esc/空白 = 清空；
 *  - 右键接管菜单；菜单打开期间禁用 Ctrl+A/I 快捷键（F17）。
 *  取消选中仅走 Esc / 空白点击 / 菜单「取消选择」。 */
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

/** 素材库批量操作入口（顶栏与右键菜单共用） */
export interface LibraryActions {
  onAiTag: () => void;
  onAssignTags: () => void;
  onExport: () => void;
  onMove: () => void;
  onDelete: () => void;
}

const GAP = 8;
const MIN_CARD = 160; // 卡片最小边长，列数自适应

interface AssetGridProps extends LibraryActions {
  onPreview: (asset: Asset) => void;
}

export default function AssetGrid({ onPreview, onAiTag, onAssignTags, onExport, onMove, onDelete }: AssetGridProps) {
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

  // 滚动近底部加载下一页；依赖 range（仅可见行区间变化时才换新引用），
  // 不依赖 getVirtualItems()（每次渲染新数组会导致 effect 每次渲染都跑）
  useEffect(() => {
    const last = virtualizer.getVirtualItems().at(-1);
    if (last && last.index >= rowCount - 2 && items.length < total) void loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualizer.range, rowCount, items.length, total, loadMore]);

  // 扣款：空白处点击 / Esc 取消选中（PRD 5.4-2）
  useEscape(useCallback(() => clear(), [clear]), selected.size > 0);

  const handleSelect = useCallback(
    (asset: Asset, index: number, e: React.MouseEvent) => {
      if (e.shiftKey) {
        rangeTo(index, orderedIds);
      } else if (e.ctrlKey || e.metaKey) {
        // Ctrl/⌘：加选/减选切换
        toggle(asset.id, index, true);
      } else if (!selected.has(asset.id)) {
        // F19：普通单击 = 追加多选（用户拍板）；单击已选中项保持不动（减选走 Ctrl+单击）
        toggle(asset.id, index, true);
      }
    },
    [toggle, rangeTo, orderedIds, selected],
  );

  const handlePreview = useCallback((asset: Asset) => onPreview(asset), [onPreview]);

  // ---- 右键菜单（v2.8） ----
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  // Ctrl+A 全选 / Ctrl+I 反选（竞品标准交互）
  // F17：菜单打开期间快捷键不生效——菜单项/误触（含中文输入法组合键）不得变更选中集
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
      // 右键未选中项 → 加入选中（F19：与普通单击一致，追加而非独占替换；已选中项不动）
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
              // P2-08 根因修复：占位格 key 不能用裸列索引（c），会与素材 key={asset.id}
              // （自增整数）在同父级撞 key（如第 4 列占位 c=3 撞 id=3）→ React 重复 key 警告。
              // 用带前缀的复合 key 彻底隔离两类 key 空间。
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
