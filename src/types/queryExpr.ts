/** 布尔查询表达式树（与 Rust db/query_expr.rs 对齐，camelCase 序列化）。
 *  表达式构建器产物 → 通过 AssetFilter.expr 传给后端，由 query_expr 递归编译。 */
import type { AssetType, MetadataFilter } from "./asset";

/** FB5-05（§8.2）：搜索范围。列名由后端枚举映射，前端只传枚举值，不出现 FTS/bigram 实现词。 */
export type SearchScope = "all" | "content" | "description" | "fileName";

/** 单一叶子条件（type 字段区分类型） */
export type LeafCond =
  | { type: "tag"; facetKey: string; tagIds: number[]; mode?: "any" | "all"; includeDescendants: boolean }
  | { type: "excludeTag"; facetKey: string; tagIds: number[] }
  | { type: "assetType"; value: AssetType }
  | { type: "untagged" }
  | { type: "metadata"; filter: MetadataFilter }
  | { type: "search"; value: string; scope?: SearchScope };

/** 布尔表达式树 */
export type QueryExpr =
  | { op: "and"; children: QueryExpr[] }
  | { op: "or"; children: QueryExpr[] }
  | { op: "not"; child: QueryExpr }
  | { op: "leaf"; cond: LeafCond };

/** 表达式构建器当前编辑状态：扁平行列表（可在界面上嵌套成组）。
 *  rows：展示层用；expr：由 rows 派生、真正发给后端的树。 */
export interface BuilderRow {
  id: string;
  /** and | or | not：与上/外层连接词 */
  joiner: "and" | "or" | "not";
  /** 条件行内容；group 表示一个子组 */
  kind: "leaf" | "group";
  cond?: LeafCond;
  children?: BuilderRow[];
}
