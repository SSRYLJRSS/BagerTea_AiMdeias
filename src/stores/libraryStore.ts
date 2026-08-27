/** 素材库数据与筛选状态（虚拟网格数据源） */
import { create } from "zustand";
import { listAssets, listAssetIds } from "@/api/assets";
import { useSelectionStore } from "@/stores/selectionStore";
import { markStartup } from "@/utils/startupMarks";
import type { Asset, AssetFilter, AssetType, FacetTagFilter, MetadataFilter } from "@/types/asset";

const PAGE_SIZE = 200;

/** 请求代际计数（模块级，跨 set 调用共享）：refresh/loadMore 响应回写前校验，
 *  过期请求（筛选已变更/已有新请求发出）直接丢弃，防异步响应覆盖竞态（P1-01） */
let requestSeq = 0;

/** 按 id 去重（保持原顺序）：refresh/loadMore 统一走这里，防后端 offset 分页
 *  在数据变动时返回重复 id → React 重复 key 警告（P2-08） */
function dedupItems(arr: Asset[]): Asset[] {
  const seen = new Set<number>();
  const out: Asset[] = [];
  for (const a of arr) {
    if (!seen.has(a.id)) {
      seen.add(a.id);
      out.push(a);
    }
  }
  return out;
}

export interface LibraryFilter {
  assetType: AssetType;
  untaggedOnly: boolean;
  tagId: number | null;
  facetFilters?: FacetTagFilter[];
  excludeTagIds?: number[];
  metadataFilters?: MetadataFilter[];
  search: string;
  /** R-21 排序：created_at（默认）| taken_at | modified_at | name | size | resolution */
  sortBy: "created_at" | "taken_at" | "modified_at" | "name" | "size" | "resolution";
  sortDir: "desc" | "asc";
  /** R-22：true = 回收站视图 */
  trashOnly: boolean;
}

/** LibraryFilter → 后端 AssetFilter（统一出口，refresh/loadMore/fetchAllIds 共用） */
function toApiFilter(f: LibraryFilter, offset: number, limit?: number): AssetFilter {
  return {
    assetType: f.assetType,
    untaggedOnly: f.untaggedOnly,
    tagId: f.tagId ?? undefined,
    facetFilters: f.facetFilters ?? [],
    excludeTagIds: f.excludeTagIds ?? [],
    metadataFilters: f.metadataFilters ?? [],
    search: f.search || undefined,
    sortBy: f.sortBy,
    sortDir: f.sortDir,
    trashOnly: f.trashOnly,
    offset,
    limit,
  };
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
  /** Viewer 是否打开（§7.3 方案 A：App 据此隐藏全局 BottomBar，与 Viewer 互斥） */
  viewerOpen: boolean;
  setViewerOpen: (open: boolean) => void;
  /** 网格滚动位置（§7.2：Viewer 关闭后恢复库页滚动上下文；AssetGridView 滚动时写入） */
  gridScrollTop: number;
  setGridScrollTop: (top: number) => void;
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  items: [],
  total: 0,
  loading: false,
  error: null,
  filter: {
    assetType: "all",
    untaggedOnly: false,
    tagId: null,
    facetFilters: [],
    excludeTagIds: [],
    metadataFilters: [],
    search: "",
    sortBy: "created_at",
    sortDir: "desc",
    trashOnly: false,
  },

  setFilter: (patch) => {
    // F18：筛选值未变化时 no-op（不刷新、不清选）。
    // 根因：GridToolbar 重渲染导致 SearchInput 的 onSearch 引用变化、防抖定时器重启，
    // 会把空串/相同值再次提交给 setFilter → 触发 B09 clear() → 「单击选中后自动取消」。
    // 任何调用源（搜索/排序/标签/类型/回收站）提交相同筛选都不应产生副作用。
    const prev = get().filter;
    const next = { ...prev, ...patch };
    if (
      prev.assetType === next.assetType &&
      prev.untaggedOnly === next.untaggedOnly &&
      prev.tagId === next.tagId &&
      JSON.stringify(prev.facetFilters ?? []) === JSON.stringify(next.facetFilters ?? []) &&
      JSON.stringify(prev.excludeTagIds ?? []) === JSON.stringify(next.excludeTagIds ?? []) &&
      JSON.stringify(prev.metadataFilters ?? []) === JSON.stringify(next.metadataFilters ?? []) &&
      prev.search === next.search &&
      prev.sortBy === next.sortBy &&
      prev.sortDir === next.sortDir &&
      prev.trashOnly === next.trashOnly
    ) {
      return;
    }
    set({ filter: next });
    useSelectionStore.getState().clear(); // B09：筛选变更清空选中，避免跨筛选残留不可见 id
    void get().refresh();
  },

  refresh: async () => {
    const seq = ++requestSeq;
    const f = get().filter;
    set({ loading: true, error: null });
    try {
      const page = await listAssets(toApiFilter(f, 0, PAGE_SIZE));
      // P1-01：响应返回时筛选可能已变更/更新请求已发出——过期响应直接丢弃，
      // 不写 items/total、不碰 loading（loading 归最新请求管）
      if (seq !== requestSeq) return;
      set({ items: dedupItems(page.items), total: page.total, loading: false });
      markStartup("library_ready"); // §4.1：素材列表 ready 打点（首次成功刷新即首屏 ready）
    } catch (e) {
      if (seq !== requestSeq) return;
      set({ error: e instanceof Error ? e.message : String(e), loading: false });
    }
  },

  loadMore: async () => {
    const { items, total, loading, filter } = get();
    if (loading || items.length >= total) return;
    const seq = ++requestSeq;
    set({ loading: true });
    try {
      // P1-01：用旧 items.length 做 offset 的请求在筛选变更后 offset 必然错位，
      // 若期间已有新请求（refresh/loadMore），旧响应必须丢弃
      const page = await listAssets(toApiFilter(filter, items.length, PAGE_SIZE));
      if (seq !== requestSeq) return;
      const known = new Set(items.map((a) => a.id));
      set({
        items: [...items, ...page.items.filter((a) => !known.has(a.id))],
        total: page.total,
        loading: false,
      });
    } catch (e) {
      if (seq !== requestSeq) return;
      set({ error: e instanceof Error ? e.message : String(e), loading: false });
    }
  },

  fetchAllIds: async () => {
    const { filter } = get();
    // 走 list_asset_ids：只取 id 数组，不拉完整 Asset、不依赖 total/limit
    return listAssetIds(toApiFilter(filter, 0));
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

  viewerOpen: false,
  setViewerOpen: (open) => {
    // 关闭 Viewer 时恢复网格滚动（组件写回 gridScrollTop；此处负责清零状态）
    set({ viewerOpen: open, ...(open ? {} : {}) });
  },

  gridScrollTop: 0,
  setGridScrollTop: (top) => set({ gridScrollTop: top }),
}));
