/** 网格多选状态：单击 / Ctrl 切换 / Shift 范围选（PRD 5.4-2）。
 *  §4.6：全选/反选触顶 100000（truncated）时记录截断标记与匹配总数，
 *  供 AssetGridView 按策略表禁用删除/反选、二次确认导出/批量打标、选择栏显示「已选 N / total」。
 *  truncated 在 clear() 或一次未截断的 setAll 前保持粘性（截断集合上的手动增删仍是残缺集）。 */
import { create } from "zustand";

/** setAll/invert 的元数据（来自 PlanIdsResult） */
export interface SelectionMeta {
  truncated: boolean;
  total: number;
}

interface SelectionState {
  selected: ReadonlySet<number>;
  /** Shift 范围选锚点（网格扁平索引） */
  anchorIndex: number | null;
  /** §4.6：最近一次全选/反选是否触顶 100000（截断集合 → 删除/反选禁用） */
  truncated: boolean;
  /** §4.6：匹配总数（未截断前），供选择栏显示「已选 N / total」 */
  selectionTotal: number;
  count: () => number;
  isSelected: (id: number) => boolean;
  /** 单击/Ctrl：toggle 单张 */
  toggle: (id: number, index: number, additive: boolean) => void;
  /** Shift：按网格索引范围选中 */
  rangeTo: (index: number, orderedIds: number[]) => void;
  /** Ctrl+A：全选给定 id 集（当前筛选结果）；meta 携带截断信息（§4.6） */
  setAll: (ids: number[], meta?: SelectionMeta) => void;
  /** Ctrl+I：反选；meta 携带截断信息（§4.6，截断时调用方应禁止） */
  invert: (allIds: number[], meta?: SelectionMeta) => void;
  clear: () => void;
}

export const useSelectionStore = create<SelectionState>((set, get) => ({
  selected: new Set<number>(),
  anchorIndex: null,
  truncated: false,
  selectionTotal: 0,

  count: () => get().selected.size,
  isSelected: (id) => get().selected.has(id),

  toggle: (id, index, additive) =>
    set((s) => {
      const next = new Set(additive ? s.selected : []);
      if (additive && next.has(id)) next.delete(id);
      else next.add(id);
      return { selected: next, anchorIndex: index };
    }),

  rangeTo: (index, orderedIds) =>
    set((s) => {
      const from = s.anchorIndex ?? index;
      const [lo, hi] = from < index ? [from, index] : [index, from];
      // E-2：闭区间内的有效 id（跳过 undefined，防止把 undefined 放进 Set）
      const idsInRange: number[] = [];
      for (let i = lo; i <= hi; i++) {
        const id = orderedIds[i];
        if (id !== undefined) idsInRange.push(id);
      }
      // E-2：范围内全部已选 → 取消整个范围；存在未选 → 补选整个范围
      const allSelected = idsInRange.every((id) => s.selected.has(id));
      const next = new Set(s.selected);
      if (allSelected) {
        for (const id of idsInRange) next.delete(id);
      } else {
        for (const id of idsInRange) next.add(id);
      }
      // E-3：操作完成后把锚点更新为当前 index
      return { selected: next, anchorIndex: index };
    }),

  setAll: (ids, meta) =>
    set((s) => ({
      selected: new Set(ids),
      anchorIndex: ids.length ? ids.length - 1 : null,
      truncated: meta?.truncated ?? s.truncated,
      selectionTotal: meta?.total ?? ids.length,
    })),

  invert: (allIds, meta) =>
    set((s) => {
      const next = new Set<number>();
      for (const id of allIds) if (!s.selected.has(id)) next.add(id);
      return { selected: next, truncated: meta?.truncated ?? s.truncated, selectionTotal: meta?.total ?? allIds.length };
    }),

  clear: () => set({ selected: new Set<number>(), anchorIndex: null, truncated: false, selectionTotal: 0 }),
}));
