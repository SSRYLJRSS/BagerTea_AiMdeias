/** 素材库数据与筛选状态（虚拟网格数据源） */
import { create } from "zustand";
import { listAssets, listAssetIds } from "@/api/assets";
import { useSelectionStore } from "@/stores/selectionStore";
import type { Asset, AssetType } from "@/types/asset";

const PAGE_SIZE = 200;

export interface LibraryFilter {
  assetType: AssetType;
  untaggedOnly: boolean;
  tagId: number | null;
  search: string;
}

interface LibraryState {
  items: Asset[];
  total: number;
  loading: boolean;
  error: string | null;
  filter: LibraryFilter;
  setFilter: (patch: Partial<LibraryFilter>) => void;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  /** 删除/打标后局部摘除，避免整页重载 */
  removeLocal: (ids: number[]) => void;
  patchLocal: (ids: number[], patch: Partial<Asset>) => void;
  /** 取当前筛选结果的全部 id（全选/反选/批量操作用；一次查询只取 id 数组） */
  fetchAllIds: () => Promise<number[]>;
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  items: [],
  total: 0,
  loading: false,
  error: null,
  filter: { assetType: "all", untaggedOnly: false, tagId: null, search: "" },

  setFilter: (patch) => {
    set((s) => ({ filter: { ...s.filter, ...patch } }));
    useSelectionStore.getState().clear(); // B09：筛选变更清空选中，避免跨筛选残留不可见 id
    void get().refresh();
  },

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const f = get().filter;
      const page = await listAssets({
        assetType: f.assetType,
        untaggedOnly: f.untaggedOnly,
        tagId: f.tagId ?? undefined,
        search: f.search || undefined,
        offset: 0,
        limit: PAGE_SIZE,
      });
      set({ items: page.items, total: page.total, loading: false });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), loading: false });
    }
  },

  loadMore: async () => {
    const { items, total, loading, filter } = get();
    if (loading || items.length >= total) return;
    set({ loading: true });
    try {
      const page = await listAssets({
        assetType: filter.assetType,
        untaggedOnly: filter.untaggedOnly,
        tagId: filter.tagId ?? undefined,
        search: filter.search || undefined,
        offset: items.length,
        limit: PAGE_SIZE,
      });
      const known = new Set(items.map((a) => a.id));
      set({
        items: [...items, ...page.items.filter((a) => !known.has(a.id))],
        total: page.total,
        loading: false,
      });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), loading: false });
    }
  },

  fetchAllIds: async () => {
    const { filter } = get();
    // 走 list_asset_ids：只取 id 数组，不拉完整 Asset、不依赖 total/limit
    return listAssetIds({
      assetType: filter.assetType,
      untaggedOnly: filter.untaggedOnly,
      tagId: filter.tagId ?? undefined,
      search: filter.search || undefined,
    });
  },

  removeLocal: (ids) => {
    const gone = new Set(ids);
    set((s) => {
      // B09：只减当前视图内实际移除的数量，避免选中含跨筛选 id 时 total 多减
      const removedInView = s.items.filter((a) => gone.has(a.id)).length;
      return {
        items: s.items.filter((a) => !gone.has(a.id)),
        total: Math.max(0, s.total - removedInView),
      };
    });
  },

  patchLocal: (ids, patch) => {
    const hit = new Set(ids);
    set((s) => ({ items: s.items.map((a) => (hit.has(a.id) ? { ...a, ...patch } : a)) }));
  },
}));
