/** 网格多选状态：单击 / Ctrl 切换 / Shift 范围选（PRD 5.4-2） */
import { create } from "zustand";

interface SelectionState {
  selected: ReadonlySet<number>;
  /** Shift 范围选锚点（网格扁平索引） */
  anchorIndex: number | null;
  count: () => number;
  isSelected: (id: number) => boolean;
  /** 单击/Ctrl：toggle 单张 */
  toggle: (id: number, index: number, additive: boolean) => void;
  /** Shift：按网格索引范围选中 */
  rangeTo: (index: number, orderedIds: number[]) => void;
  /** Ctrl+A：全选给定 id 集（当前筛选结果） */
  setAll: (ids: number[]) => void;
  /** Ctrl+I：反选 */
  invert: (allIds: number[]) => void;
  clear: () => void;
}

export const useSelectionStore = create<SelectionState>((set, get) => ({
  selected: new Set<number>(),
  anchorIndex: null,

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
      const next = new Set(s.selected);
      for (let i = lo; i <= hi; i++) next.add(orderedIds[i]);
      return { selected: next };
    }),

  setAll: (ids) => set({ selected: new Set(ids), anchorIndex: ids.length ? ids.length - 1 : null }),

  invert: (allIds) =>
    set((s) => {
      const next = new Set<number>();
      for (const id of allIds) if (!s.selected.has(id)) next.add(id);
      return { selected: next };
    }),

  clear: () => set({ selected: new Set<number>(), anchorIndex: null }),
}));
