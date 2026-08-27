/** 素材相关命令封装（commands/assets_cmd.rs）→ 超级搜索查询（P4 表达式构建器） */
import { invoke } from "./client";
import { listAssets, listAssetIds } from "./assets";
import type { AssetFilter, AssetPage, ResolvedSearchQuery } from "@/types/asset";
import type { QueryExpr } from "@/types/queryExpr";
import type { AiSearchParseResult } from "@/types/superSearch";

/** ResolvedSearchQuery + 可选 expr → 后端 AssetFilter（分页由调用方提供） */
export function queryToFilter(
  q: ResolvedSearchQuery,
  offset: number,
  limit?: number,
  expr?: QueryExpr,
): AssetFilter {
  return {
    assetType: q.assetType,
    untaggedOnly: q.untaggedOnly,
    facetFilters: q.facetFilters.map((f) => ({
      facetKey: f.facetKey,
      tagIds: f.tagIds,
      mode: f.mode,
      includeDescendants: f.includeDescendants,
    })),
    excludeTagIds: q.excludeTagIds,
    metadataFilters: q.metadataFilters,
    search: q.search || undefined,
    sortBy: q.sortBy,
    sortDir: q.sortDir,
    trashOnly: false,
    expr,
    offset,
    limit,
  };
}

export function listSuperAssets(
  q: ResolvedSearchQuery,
  offset: number,
  limit?: number,
  expr?: QueryExpr,
): Promise<AssetPage> {
  return listAssets(queryToFilter(q, offset, limit, expr));
}

export function listSuperAssetIds(q: ResolvedSearchQuery, expr?: QueryExpr): Promise<number[]> {
  return listAssetIds(queryToFilter(q, 0, undefined, expr));
}

/** P3：AI 自然语言 → 查询意图 + 执行对象 */
export function aiParseSearchQuery(
  text: string,
  currentQuery?: ResolvedSearchQuery,
): Promise<AiSearchParseResult> {
  return invoke<AiSearchParseResult>("ai_parse_search_query", { text, currentQuery });
}
