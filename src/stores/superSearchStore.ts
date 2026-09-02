/** 超级搜索数据与筛选状态（P2 + FB5-05 §9.6/§9.7）：
 *  条件以 expr（QueryExpr）为唯一执行事实源；query 扁平字段仅供手动条件链路与排序。
 *  error（数据查询）与 aiError（AI 解析）分离：AI 解析失败保留当前 query/expr/items，不触发 refresh。
 *  请求代际防旧响应覆盖新查询。 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { listSuperAssets, listSuperAssetIds, aiParseSearchQuery } from "@/api/superSearch";
import { useSelectionStore } from "@/stores/selectionStore";
import type { Asset, ResolvedSearchQuery, MetadataFilter } from "@/types/asset";
import type { QueryExpr } from "@/types/queryExpr";
import type { AiApplyMode, ResolvedTag, SearchPlanV3, ShouldClause } from "@/types/superSearch";
import {
  mergeQueryExpr,
  normalizeExpr,
  removeExprAtPath,
  resolvedQueryToExpr,
  serializeExpr,
  syncQueryFromExpr,
} from "@/utils/queryExprUtils";
import type { ExprPath } from "@/utils/queryExprUtils";

const PAGE_SIZE = 200;

/** 默认查询：全库、非回收站、入库时间降序 */
function defaultQuery(): ResolvedSearchQuery {
  return {
    search: "",
    assetType: "all",
    untaggedOnly: false,
    facetFilters: [],
    excludeTagIds: [],
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

/** FB5-05（§9.6.1）：expr 更新后只保留仍被引用的 resolvedTags 名称映射 */
function filterResolvedTagsByExpr(tags: ResolvedTag[], expr?: QueryExpr): ResolvedTag[] {
  if (!expr) return [];
  const ids = new Set<number>();
  const collect = (e: QueryExpr) => {
    if (e.op === "leaf") {
      const c = e.cond;
      if (c.type === "tag" || c.type === "excludeTag") c.tagIds.forEach((id) => ids.add(id));
    } else if (e.op === "not") collect(e.child);
    else e.children.forEach(collect);
  };
  collect(expr);
  return tags.filter((t) => ids.has(t.tagId));
}

/** FB5-05（§9.6）：append 模式按 tagId 合并旧映射与新映射 */
function mergeResolvedTags(a: ResolvedTag[], b: ResolvedTag[]): ResolvedTag[] {
  const byId = new Map<number, ResolvedTag>();
  for (const t of [...a, ...b]) byId.set(t.tagId, t);
  return Array.from(byId.values());
}

export interface SuperSearchState {
  query: ResolvedSearchQuery;
  /** 布尔表达式树：AI 结果 / 构建器产物；存在时优先于 query 的扁平字段（后端 expr 优先） */
  expr?: QueryExpr;
  /** S1/S6：AI 解析的完整 SearchPlanV3（filter/must_not/should/min_should/ranking）。
   *  持久化随行（hydrate 版本迁移见 migratePlanV3）；手动编辑条件（setExpr）时清空，
   *  避免双源 —— 列表执行当前仍走 expr（filter 语义），should 加分在 U 波次 UI 消费。 */
  plan?: SearchPlanV3 | null;
  items: Asset[];
  total: number;
  loading: boolean;
  /** 数据查询错误（refresh/loadMore） */
  error: string | null;
  /** AI 解析错误（§9.7：与 error 分离，失败不触发 refresh、不丢当前条件） */
  aiError: string | null;
  aiInput: string;
  aiLoading: boolean;
  aiExplanation: string | null;
  warnings: string[];
  /** W6-5：AI 解析三态（完全理解 / 部分理解 / 按关键词搜索） */
  parseStatus: "full" | "partial" | "keyword" | null;
  /** AI 已解析标签（tagId→名称/分面），供 chips 可读展示 */
  resolvedTags: ResolvedTag[];

  setQuery: (patch: Partial<ResolvedSearchQuery>) => void;
  /** P4：设置表达式树（并清空扁平查询的对应字段，避免双源） */
  setExpr: (expr: QueryExpr | undefined) => void;
  replaceQuery: (query: ResolvedSearchQuery, expr?: QueryExpr) => void;
  setAiInput: (v: string) => void;
  setAiResult: (explanation: string, warnings: string[]) => void;
  clearAiResult: () => void;
  /** FB5-05（§9.6）：AI 解析并应用（默认替换当前条件；append 则与整棵现有 expr AND 合并） */
  applyAiSearch: (text: string, mode?: AiApplyMode) => Promise<void>;
  /** FB5-05（§9.6.1）：按 expr 节点路径删除单个条件（chips 删除用，禁止走 setQuery） */
  removeExprAtPath: (path: ExprPath) => void;
  /** U-5：加分项（should）编辑 —— 覆盖整个 should 数组与最低命中数。
   *  加分项是非嵌套叶子（ShouldClause.cond），不改变结果集（expr 单源保持），只参与排序。 */
  setPlanShould: (should: ShouldClause[], minimumShouldMatch: number) => void;
  /** U-5：按索引移除单条加分项（chips/加分区删除用） */
  removePlanShould: (index: number) => void;
  /** FB5-05（§9.6.1）：排序 chip 独立 action（只改 sortBy/sortDir） */
  setSort: (sortBy: ResolvedSearchQuery["sortBy"], sortDir: "desc" | "asc") => void;
  /** FB5-05（§9.6.1）：清除全部——同时清 expr 和兼容扁平筛选 */
  clearConditions: () => void;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  fetchAllIds: () => Promise<number[]>;
  clearQuery: () => void;
}

/** S6：本地保存的 plan 版本迁移（与后端 db/search_plan.rs migrate_plan 对齐的最小版）。
 *  planSchemaVersion > 当前（用户降级应用）→ None（丢弃 + 前端可提示）；≤ 当前视为可迁移。
 *  当前 schema v3 无历史结构差异，恒等返回；未来结构变更在此加分支。 */
export function migratePlanV3(plan: SearchPlanV3): SearchPlanV3 | null {
  const CURRENT_PLAN_SCHEMA = 3;
  if (plan.planSchemaVersion > CURRENT_PLAN_SCHEMA) {
    return null;
  }
  return { ...plan, planSchemaVersion: CURRENT_PLAN_SCHEMA };
}

// W5f-f6：搜索条件持久化（localStorage）—— 只存 expr + query（带版本号），
// hydrate 不触发请求；进页走既有代际机制单次查询（partialize 排除 items/loading 等瞬态）。
export const useSuperSearchStore = create<SuperSearchState>()(
  persist(
    (set, get) => ({
  query: defaultQuery(),
  expr: undefined,
  plan: null,
  items: [],
  total: 0,
  loading: false,
  error: null,
  aiError: null,
  aiInput: "",
  aiLoading: false,
  aiExplanation: null,
  warnings: [],
  parseStatus: null,
  resolvedTags: [],

  setQuery: (patch) => {
    const prev = get().query;
    const next = { ...prev, ...patch };
    if (queryEqual(prev, next)) return;
    invalidatePendingRequests();
    // 改扁平查询时清掉表达式树（避免双源）
    set({ query: next, expr: undefined, plan: null, warnings: [], aiExplanation: null, aiError: null, aiLoading: false, resolvedTags: [] });
    useSelectionStore.getState().clear();
    scheduleRefresh(get().refresh);
  },

  setExpr: (expr) => {
    const currentExpr = get().expr;
    if ((!expr && !currentExpr) || (expr && currentExpr && serializeExpr(expr) === serializeExpr(currentExpr))) return;
    invalidatePendingRequests();
    const query = syncQueryFromExpr(get().query, expr);
    // §9.6.1：expr 更新后清理已不再引用的名称映射
    const resolvedTags = filterResolvedTagsByExpr(get().resolvedTags, expr);
    // U-5：expr 是 filter 的唯一事实源 —— 已存在 plan（AI 加分）时把 plan.filter 同步为 expr，
    // 不再整棵清空 plan（否则手动改必须区会丢掉加分项）；expr 清空时加分无从依附，plan 一并清。
    const curPlan = get().plan;
    const plan = curPlan && expr ? { ...curPlan, filter: expr } : null;
    set({ query, expr, plan, warnings: [], aiExplanation: null, aiError: null, aiLoading: false, resolvedTags });
    useSelectionStore.getState().clear();
    scheduleRefresh(get().refresh);
  },

  replaceQuery: (query, expr) => {
    const prev = get().query;
    const currentExpr = get().expr;
    const sameExpr = (!expr && !currentExpr) || (expr && currentExpr && serializeExpr(expr) === serializeExpr(currentExpr));
    if (queryEqual(prev, query) && sameExpr) return;
    invalidatePendingRequests();
    set({ query, expr, plan: null, warnings: [], aiExplanation: null, aiError: null, aiLoading: false, resolvedTags: [] });
    useSelectionStore.getState().clear();
    scheduleRefresh(get().refresh);
  },

  setAiInput: (v) =>
    set((s) =>
      v === s.aiInput
        ? {}
        : { aiInput: v, aiError: null, aiExplanation: null, warnings: [] },
    ),
  setAiResult: (explanation, warnings) =>
    set({ aiExplanation: explanation, warnings, parseStatus: warnings.length > 0 ? "partial" : "full" }),
  clearAiResult: () =>
    set({ aiExplanation: null, warnings: [], parseStatus: null, resolvedTags: [], aiError: null }),

  applyAiSearch: async (text, mode = "replace") => {
    const aiSeq = ++requestSeq;
    const cur = get().query;
    set({ aiLoading: true, aiError: null });
    try {
      const result = await aiParseSearchQuery(text);
      if (aiSeq !== requestSeq) return;
      // §9.6：后端返回的 expr 为唯一执行事实源，前端不得从扁平 query 再猜一棵树
      const aiExpr = result.expr ?? undefined;
      const aiPlan = result.plan ?? null;
      let nextExpr: QueryExpr | undefined;
      let nextPlan: SearchPlanV3 | null;
      let nextQuery: ResolvedSearchQuery;
      let nextResolvedTags: ResolvedTag[];
      if (mode === "replace") {
        nextExpr = aiExpr;
        // plan 仅当替换整个条件时携带（append 合并后 plan 不再精确，清空走 expr 链路）
        nextPlan = aiPlan;
        // query 只同步 sortBy/sortDir，不从复杂 expr 反推扁平条件（§9.6）
        nextQuery = { ...defaultQuery(), sortBy: result.sortBy, sortDir: result.sortDir };
        nextResolvedTags = result.resolvedTags;
      } else {
        // append：两个完整查询组以 AND 合并（不破坏内部 OR 分组）
        const baseExpr = get().expr ?? resolvedQueryToExpr(cur);
        nextExpr = normalizeExpr(mergeQueryExpr(baseExpr, aiExpr) as QueryExpr);
        nextPlan = null;
        nextQuery = { ...cur, sortBy: result.sortBy, sortDir: result.sortDir };
        nextResolvedTags = mergeResolvedTags(get().resolvedTags, result.resolvedTags);
      }
      // §9.6：query 只同步 sortBy/sortDir，不从复杂 expr 反推扁平条件（§9.6）
      const synced = { ...nextQuery };
      set({
        query: synced,
        expr: nextExpr,
        plan: nextPlan,
        aiExplanation: result.explanation,
        warnings: result.warnings,
        parseStatus: result.parseStatus,
        resolvedTags: nextResolvedTags,
        aiLoading: false,
      });
      useSelectionStore.getState().clear();
      scheduleRefresh(get().refresh);
    } catch (e) {
      if (aiSeq !== requestSeq) return;
      // §9.7：AI 解析失败只设 aiError；保留当前 query/expr/items/total，不触发 refresh
      set({ aiLoading: false, aiError: e instanceof Error ? e.message : String(e) });
    }
  },

  removeExprAtPath: (path) => {
    const expr = get().expr;
    if (!expr) return;
    const next = removeExprAtPath(expr, path);
    get().setExpr(next);
  },

  setPlanShould: (should, minimumShouldMatch) => {
    const cur = get();
    const clamped = Math.max(0, Math.min(should.length, Math.floor(minimumShouldMatch)));
    const plan: SearchPlanV3 = cur.plan ?? {
      // U-5：手动条件首次加分时，从当前 expr 起一个最小 plan（filter 单源镜像）
      planSchemaVersion: 3,
      normalizationVersion: 1,
      compilerVersion: 1,
      filter: cur.expr ?? null,
      mustNot: null,
      should: [],
      minimumShouldMatch: 0,
      retrievers: { retrievers: [] },
      ranking: { type: "field", key: "created_at", dir: "desc" },
    };
    set({ plan: { ...plan, should: should.slice(0, 12), minimumShouldMatch: clamped } });
  },

  removePlanShould: (index) => {
    const plan = get().plan;
    if (!plan) return;
    const should = plan.should.filter((_, i) => i !== index);
    get().setPlanShould(should, Math.min(plan.minimumShouldMatch, should.length));
  },

  setSort: (sortBy, sortDir) => {
    const cur = get().query;
    if (cur.sortBy === sortBy && cur.sortDir === sortDir) return;
    set({ query: { ...cur, sortBy, sortDir } });
    useSelectionStore.getState().clear();
    scheduleRefresh(get().refresh);
  },

  clearConditions: () => {
    invalidatePendingRequests();
    const def = defaultQuery();
    set({ query: def, expr: undefined, plan: null, warnings: [], aiExplanation: null, aiError: null, aiLoading: false, resolvedTags: [] });
    useSelectionStore.getState().clear();
    scheduleRefresh(get().refresh);
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
}),
{
  name: "super-search-conditions",
  version: 1,
  partialize: (state) => ({
    expr: state.expr,
    query: state.query,
    // S6：整个 SearchPlanV3 随行持久化（hydrate 时版本迁移见下方 migrate）
    plan: state.plan,
  }),
  // S6：hydrate 时 plan_schema_version > 当前（用户降级应用）→ 丢弃；否则保留
  migrate: (persisted) => {
    const p = persisted as { plan?: SearchPlanV3 | null };
    if (p?.plan) {
      const migrated = migratePlanV3(p.plan);
      return { ...(persisted as object), plan: migrated } as never;
    }
    return persisted as never;
  },
},
  ),
);

export type { MetadataFilter };
