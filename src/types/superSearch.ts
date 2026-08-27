import type { ResolvedSearchQuery, SearchIntent, MetadataFilter } from "./asset";

/** AI 解析结果：intent + 已解析执行对象 + 解释 + warnings + 已解析标签 */
export interface ResolvedTag {
  facetKey: string;
  text: string;
  tagId: number;
  path: string;
}

export interface AiSearchParseResult {
  intent: SearchIntent;
  query: ResolvedSearchQuery;
  explanation: string;
  warnings: string[];
  resolvedTags: ResolvedTag[];
}

/** 追加模式：默认替换当前条件；用户明确选择才追加 */
export type AiApplyMode = "replace" | "append";

export type { ResolvedSearchQuery, SearchIntent, MetadataFilter };
