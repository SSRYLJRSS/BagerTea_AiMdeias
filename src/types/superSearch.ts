/** 超级搜索 AI 协议（FB5-05 §9）：SearchIntent V2 单一概念协议 + 后端 QueryExpr 事实源。 */
import type { MetadataFilter, ResolvedSearchQuery } from "./asset";
import type { QueryExpr } from "./queryExpr";

/** 原子概念：模型输出的规范名词/短语（组内 AND、组间 OR） */
export interface SearchConceptV2 {
  text: string;
  role?: string;
  /** 模型建议的分面 key 提示（本地解析收窄用，可空） */
  facetHint?: string | null;
  /** 0~1；低于 0.55 不进入硬筛选（仅 warning） */
  confidence?: number | null;
}

/** 文本搜索项：明确文件名片段/引号原文/无法映射的具体内容 */
export interface IntentTextTerm {
  text: string;
  /** all | content | description | fileName（映射到后端 SearchScope） */
  scope: "all" | "content" | "description" | "fileName";
}

/** 一个条件组：组内全部条件 AND */
export interface SearchGroupV2 {
  assetType: "all" | "image" | "video";
  concepts: SearchConceptV2[];
  textTerms: IntentTextTerm[];
  metadata: MetadataFilter[];
}

/** SearchIntent V2：组间 OR；exclusions 对整个正向结果全局 NOT。
 *  旧字段 search/tags/excludeTags/unresolved/relation 全部删除（§9.1）。 */
export interface SearchIntentV2 {
  groups: SearchGroupV2[];
  exclusions: SearchConceptV2[];
  sortBy?: string | null;
  sortDir?: "asc" | "desc" | null;
}

/** 已解析标签（AI 解析结果内：tagId → 名称/分面，供 chips 可读展示） */
export interface ResolvedTag {
  facetKey: string;
  text: string;
  tagId: number;
  path: string;
}

/** FB5-05（§9.5）：AI 解析结果。expr 为唯一执行事实源；排序单独返回；
 *  不再含扁平 query（前端不得从扁平条件再猜一棵树）。 */
export interface AiSearchParseResult {
  intent: SearchIntentV2;
  expr: QueryExpr | null;
  sortBy: ResolvedSearchQuery["sortBy"];
  sortDir: "desc" | "asc";
  explanation: string;
  warnings: string[];
  resolvedTags: ResolvedTag[];
  /** W6-5：完全理解 / 部分理解 / 按关键词搜索 三态 */
  parseStatus: "full" | "partial" | "keyword";
}

/** 追加模式：默认替换当前条件；用户明确选择才追加 */
export type AiApplyMode = "replace" | "append";

export type { ResolvedSearchQuery, MetadataFilter };
