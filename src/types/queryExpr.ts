/** 布尔查询表达式树（与 Rust db/query_expr.rs 对齐，camelCase 序列化）。
 *  表达式构建器产物 → 通过 AssetFilter.expr 传给后端，由 query_expr 递归编译。 */
import type { AssetType, MetadataFilter } from "./asset";

/** FB5-05（§8.2）：搜索范围。列名由后端枚举映射，前端只传枚举值，不出现 FTS/bigram 实现词。 */
export type SearchScope = "all" | "content" | "description" | "fileName";

/** S5（§4.2b）：标签词匹配模式 —— 与后端 TermMatch 对齐（camelCase）。
 *  只对 `tag` 叶子上的 termQuery（按词查）生效；显式 chip（tagIds）不受影响。
 *  缺省 = alias（精确命中规范名或别名）。 */
export type TermMatch = "exact" | "alias" | "prefix" | "contains" | "fuzzy";

/** 单一叶子条件（type 字段区分类型） */
export type LeafCond =
  | {
      type: "tag";
      facetKey: string;
      tagIds: number[];
      mode?: "any" | "all";
      includeDescendants: boolean;
      /** S5：按词查（AI/搜索框路径）—— 词先按 termMatch 扩展成一组 tagId 与 tagIds 求并集 */
      termQuery?: string | null;
      termMatch?: TermMatch | null;
    }
  | { type: "excludeTag"; facetKey: string; tagIds: number[] }
  | { type: "assetType"; value: AssetType }
  | { type: "untagged" }
  | { type: "metadata"; filter: MetadataFilter }
  | { type: "search"; value: string; scope?: SearchScope }
  /** W2-7/W3-3d：分面有任意标签 / 没有标签（打标补漏核心场景） */
  | { type: "facetHasAny"; facetKey: string }
  | { type: "facetMissing"; facetKey: string }
  /** V24（Phase 7-2）：数值分面条件（asset_facet_numbers，与 Rust LeafCond::FacetNumber 对齐） */
  | {
      type: "facetNumber";
      facetKey: string;
      op: "eq" | "gt" | "gte" | "lt" | "lte" | "between";
      value: number;
      maxValue?: number | null;
    };

/** 布尔表达式树 */
export type QueryExpr =
  | { op: "and"; children: QueryExpr[] }
  | { op: "or"; children: QueryExpr[] }
  | { op: "not"; child: QueryExpr }
  | { op: "leaf"; cond: LeafCond };

/* 说明：QueryBuilder 的手动编辑视图只提供必须、优先、排除三个平铺分区；
 * QueryExpr 仍保留递归结构，用于承载 AI/历史查询并交给后端原样执行。 */
