/** QueryExpr 与 AssetFilter 的互转 + 构建器 JSON 序列化。 */
import type { AssetFilter, FacetTagFilter, MetadataFilter, ResolvedSearchQuery } from "@/types/asset";
import type { LeafCond, QueryExpr } from "@/types/queryExpr";

/** 扁平 AssetFilter → QueryExpr（多 AND + 排除 NOT）。当 expr 已存在时直接返回它。 */
export function buildExprFromFilter(f: AssetFilter): QueryExpr {
  if (f.expr) return f.expr;
  const leaves: QueryExpr[] = [];
  if (f.search) leaves.push(leaf({ type: "search", value: f.search }));
  if (f.assetType && f.assetType !== "all") leaves.push(leaf({ type: "assetType", value: f.assetType }));
  if (f.untaggedOnly) leaves.push(leaf({ type: "untagged" }));
  for (const fct of f.facetFilters ?? []) {
    if (!fct.tagIds.length) continue;
    leaves.push(
      leaf({
        type: "tag",
        facetKey: fct.facetKey,
        tagIds: fct.tagIds,
        mode: fct.mode ?? "any",
        includeDescendants: fct.includeDescendants,
      }),
    );
  }
  for (const tagId of f.excludeTagIds ?? []) {
    leaves.push(leaf({ type: "excludeTag", facetKey: "", tagIds: [tagId] }));
  }
  for (const m of f.metadataFilters ?? []) {
    leaves.push(leaf({ type: "metadata", filter: m }));
  }
  if (leaves.length === 0) return { op: "and", children: [] };
  if (leaves.length === 1) return leaves[0];
  return { op: "and", children: leaves };
}

/** AI/后端返回的执行查询 -> 公式树。空查询不制造后端无法执行的空分组。 */
export function resolvedQueryToExpr(q: ResolvedSearchQuery): QueryExpr | undefined {
  const leaves: QueryExpr[] = [];
  if (q.search.trim()) leaves.push(leaf({ type: "search", value: q.search.trim() }));
  if (q.assetType !== "all") leaves.push(leaf({ type: "assetType", value: q.assetType }));
  if (q.untaggedOnly) leaves.push(leaf({ type: "untagged" }));
  for (const f of q.facetFilters) {
    if (!f.tagIds.length) continue;
    leaves.push(leaf({
      type: "tag",
      facetKey: f.facetKey,
      tagIds: f.tagIds,
      mode: f.mode,
      includeDescendants: f.includeDescendants,
    }));
  }
  for (const tagId of q.excludeTagIds) {
    leaves.push(leaf({ type: "excludeTag", facetKey: "", tagIds: [tagId] }));
  }
  for (const filter of q.metadataFilters) leaves.push(leaf({ type: "metadata", filter }));
  if (leaves.length === 0) return undefined;
  return leaves.length === 1 ? leaves[0] : { op: "and", children: leaves };
}

/** 追加 AI 条件时保留已有布尔结构，并以 AND 组合两个条件组。 */
export function mergeQueryExpr(a?: QueryExpr, b?: QueryExpr): QueryExpr | undefined {
  if (!a) return b;
  if (!b) return a;
  const children = [
    ...(a.op === "and" ? a.children : [a]),
    ...(b.op === "and" ? b.children : [b]),
  ];
  return children.length === 1 ? children[0] : { op: "and", children };
}

function leaf(cond: LeafCond): QueryExpr {
  return { op: "leaf", cond };
}

/** QueryExpr → AssetFilter 的扁平字段（用于兼容非 expr 链路或回填）。
 *  只提取 AND 顶层的叶子/简单形态；复杂嵌套仅保留 expr 本身。 */
export function queryExprToFilterFields(e: QueryExpr): {
  search?: string;
  assetType?: AssetFilter["assetType"];
  untaggedOnly?: boolean;
  facetFilters?: FacetTagFilter[];
  excludeTagIds?: number[];
  metadataFilters?: MetadataFilter[];
} {
  const children = e.op === "and" ? e.children : [e];
  const out: ReturnType<typeof queryExprToFilterFields> = {};
  const facetFilters: FacetTagFilter[] = [];
  const excludeTagIds: number[] = [];
  const metadataFilters: MetadataFilter[] = [];
  for (const c of children) {
    if (c.op === "leaf") {
      const cond = c.cond;
      if (cond.type === "search") out.search = cond.value;
      else if (cond.type === "assetType") out.assetType = cond.value;
      else if (cond.type === "untagged") out.untaggedOnly = true;
      else if (cond.type === "tag") {
        facetFilters.push({ facetKey: cond.facetKey, tagIds: cond.tagIds, mode: cond.mode ?? "any", includeDescendants: cond.includeDescendants });
      } else if (cond.type === "excludeTag") excludeTagIds.push(...cond.tagIds);
      else if (cond.type === "metadata") metadataFilters.push(cond.filter);
    }
  }
  if (facetFilters.length) out.facetFilters = facetFilters;
  if (excludeTagIds.length) out.excludeTagIds = excludeTagIds;
  if (metadataFilters.length) out.metadataFilters = metadataFilters;
  return out;
}

/** 公式树同步回 query 的兼容字段；复杂 OR/NOT 仍以 expr 为真实执行源。 */
export function syncQueryFromExpr(q: ResolvedSearchQuery, expr?: QueryExpr): ResolvedSearchQuery {
  const base: ResolvedSearchQuery = {
    ...q,
    search: "",
    assetType: "all",
    untaggedOnly: false,
    facetFilters: [],
    excludeTagIds: [],
    metadataFilters: [],
  };
  if (!expr) return base;
  return { ...base, ...queryExprToFilterFields(expr) };
}

/** 把 QueryExpr 转成可发送给后端的 AssetFilter.expr 外的扁平字段（expr 本身单独存在）。 */
export function queryExprToAssetFilterFields(e: QueryExpr): Partial<AssetFilter> {
  const f = queryExprToFilterFields(e);
  return { ...f, expr: e };
}

/** 序列化整棵树（JSON 字符串，供 store 比较脏状态） */
export function serializeExpr(e: QueryExpr): string {
  return JSON.stringify(e);
}
