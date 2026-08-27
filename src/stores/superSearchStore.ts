/** 超级搜索数据与筛选状态（P2）：独立于 libraryStore，避免污染普通素材库。
 *  query 是 ResolvedSearchQuery（不含分页）；分页由 offset/items 管理。
 *  请求代际防旧响应覆盖新查询。 */
import { create } from "zustand";
import { listSuperAssets, listSuperAssetIds, aiParseSearchQuery } from "@/api/superSearch";
import { useSelectionStore } from "@/stores/selectionStore";
import type { Asset, ResolvedSearchQuery, MetadataFilter } from "@/types/asset";
import type { QueryExpr } from "@/types/queryExpr";
import type { AiApplyMode } from "@/types/superSearch";
import { mergeQueryExpr, resolvedQueryToExpr, serializeExpr, syncQueryFromExpr } from "@/utils/queryExprUtils";

const PAGE_SIZE = 200;

/** 默认查询：全库、非回收站、入库时间降序 */
function defaultQuery(): ResolvedSearchQuery {
  return {
    search: "",
    assetType: "all",
    untaggedOnly: false,
    facetFilters: [],
    excludeTagIds: [],
    missingFacetKeys: [],
    metadataFilters: [],
    sortBy: "created_at",
    sortDir: "desc",
  };
}

let requestSeq = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRefresh(refresh: () => Promise<void>) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refresh();
  }, 180);
}

function invalidatePendingRequests() {
  requestSeq += 1;
}

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

/** 深度比较两个查询是否相等（用于「查询变化清空选中」判断） */
function queryEqual(a: ResolvedSearchQuery, b: ResolvedSearchQuery): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface SuperSearchState {
  query: ResolvedSearchQuery;
  /** 布尔表达式树：表达式构建器产物，存在时优先于 query 的扁平字段 */
  expr?: QueryExpr;
  items: Asset[];
  total: number;
  loading: boolean;
  error: string | null;
  aiInput: string;
  aiLoading: boolean;
  aiExplanation: string | null;
  warnings: string[];

  setQuery: (patch: Partial<ResolvedSearchQuery>) => void;
  /** P4：设置表达式树（并清空扁平查询的对应字段，避免双源） */
  setExpr: (expr: QueryExpr | undefined) => void;
  replaceQuery: (query: ResolvedSearchQuery, expr?: QueryExpr) => void;
  setAiInput: (v: string) => void;
  setAiResult: (explanation: string, warnings: string[]) => void;
  clearAiResult: () => void;
  /** P3：AI 解析并应用（默认替换当前条件；append 则合并） */
  applyAiSearch: (text: string, mode?: AiApplyMode) => Promise<void>;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  fetchAllIds: () => Promise<number[]>;
  clearQuery: () => void;
}

export const useSuperSearchStore = create<SuperSearchState>((set, get) => ({
  query: defaultQuery(),
  expr: undefined,
  items: [],
  total: 0,
  loading: false,
  error: null,
  aiInput: "",
  aiLoading: false,
  aiExplanation: null,
  warnings: [],

  setQuery: (patch) => {
    const prev = get().query;
    const next = { ...prev, ...patch };
    if (queryEqual(prev, next)) return;
    invalidatePendingRequests();
    // 改扁平查询时清掉表达式树（避免双源）
    set({ query: next, expr: undefined, warnings: [], aiExplanation: null, aiLoading: false });
    useSelectionStore.getState().clear();
    scheduleRefresh(get().refresh);
  },

  setExpr: (expr) => {
    const currentExpr = get().expr;
    if ((!expr && !currentExpr) || (expr && currentExpr && serializeExpr(expr) === serializeExpr(currentExpr))) return;
    invalidatePendingRequests();
    const query = syncQueryFromExpr(get().query, expr);
    set({ query, expr, warnings: [], aiExplanation: null, aiLoading: false });
    useSelectionStore.getState().clear();
    scheduleRefresh(get().refresh);
  },

  replaceQuery: (query, expr) => {
    const prev = get().query;
    const currentExpr = get().expr;
    const sameExpr = (!expr && !currentExpr) || (expr && currentExpr && serializeExpr(expr) === serializeExpr(currentExpr));
    if (queryEqual(prev, query) && sameExpr) return;
    invalidatePendingRequests();
    set({ query, expr, warnings: [], aiExplanation: null, aiLoading: false });
    useSelectionStore.getState().clear();
    scheduleRefresh(get().refresh);
  },

  setAiInput: (v) => set({ aiInput: v }),
  setAiResult: (explanation, warnings) => set({ aiExplanation: explanation, warnings }),
  clearAiResult: () => set({ aiExplanation: null, warnings: [] }),

  applyAiSearch: async (text, mode = "replace") => {
    const aiSeq = ++requestSeq;
    const cur = get().query;
    set({ aiLoading: true });
    try {
      const result = await aiParseSearchQuery(text, cur);
      if (aiSeq !== requestSeq) return;
      const aiExpr = resolvedQueryToExpr(result.query);
      let next: ResolvedSearchQuery;
      let nextExpr: QueryExpr | undefined;
      if (mode === "replace") {
        next = result.query;
        nextExpr = aiExpr;
      } else {
        nextExpr = mergeQueryExpr(get().expr ?? resolvedQueryToExpr(cur), aiExpr);
        next = syncQueryFromExpr({
          ...cur,
          sortBy: result.query.sortBy,
          sortDir: result.query.sortDir,
        }, nextExpr);
      }
      set({
        query: next,
        expr: nextExpr,
        aiExplanation: result.explanation,
        warnings: result.warnings,
        aiLoading: false,
      });
      useSelectionStore.getState().clear();
      scheduleRefresh(get().refresh);
    } catch (e) {
      if (aiSeq !== requestSeq) return;
      set({ aiLoading: false });
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  refresh: async () => {
    const seq = ++requestSeq;
    const { query, expr } = get();
    set({ loading: true, error: null });
    try {
      const page = await listSuperAssets(query, 0, PAGE_SIZE, expr);
      if (seq !== requestSeq) return;
      set({ items: dedupItems(page.items), total: page.total, loading: false });
    } catch (e) {
      if (seq !== requestSeq) return;
      set({ error: e instanceof Error ? e.message : String(e), loading: false });
    }
  },

  loadMore: async () => {
    const { items, total, loading, query, expr } = get();
    if (loading || items.length >= total) return;
    const seq = ++requestSeq;
    set({ loading: true });
    try {
      const page = await listSuperAssets(query, items.length, PAGE_SIZE, expr);
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
    const { query, expr } = get();
    return listSuperAssetIds(query, expr);
  },

  clearQuery: () => {
    const def = defaultQuery();
    void get().replaceQuery(def, undefined);
  },
}));

export type { MetadataFilter };
