/** 超级搜索 AI 协议（FB5-05 §9 + S1/S3）：SearchIntent V3（required + preferred）
 *  + 后端 QueryExpr（必须部分）事实源 + SearchPlanV3（含 should 加分，供三段式 UI）。 */
import type { MetadataFilter, ResolvedSearchQuery } from "./asset";
import type { LeafCond, QueryExpr } from "./queryExpr";

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

/** 词匹配模式（与后端 TermMatch 对齐，camelCase） */
export type TermMatch = "exact" | "alias" | "prefix" | "contains" | "fuzzy";

/** S3：V3 概念 —— V2 字段 + necessity/weight/evidence/termMatch */
export interface SearchConceptV3 {
  text: string;
  role?: string;
  facetHint?: string | null;
  confidence?: number | null;
  /** required（进 filter）| preferred（加分项 → should）；缺省 required */
  necessity?: "required" | "preferred";
  /** 加分权重：只给三档 0.5 / 1.0 / 2.0 */
  weight?: number | null;
  /** 模型对「为什么判为加分」的原文依据（守卫校验，编造会降级） */
  evidence?: string | null;
  termMatch?: TermMatch | null;
}

/** 一个条件组：组内全部条件 AND；preferred 为加分项（不淘汰，只影响排序） */
export interface SearchGroupV3 {
  assetType: "all" | "image" | "video";
  concepts: SearchConceptV3[];
  textTerms: IntentTextTerm[];
  metadata: MetadataFilter[];
  preferred: SearchConceptV3[];
}

/** SearchIntent V3：组间 OR；exclusions 对整个正向结果全局 NOT。 */
export interface SearchIntentV3 {
  groups: SearchGroupV3[];
  exclusions: SearchConceptV3[];
  sortBy?: string | null;
  sortDir?: "asc" | "desc" | null;
}

/** S1：加权可选子句（should）——满足则加分，不满足不淘汰 */
export interface ShouldClause {
  cond: LeafCond;
  /** 0.5 | 1.0 | 2.0（UI 只给三档） */
  weight: number;
  label: string;
}

/** S2：排序方式 */
export type Ranking =
  | { type: "field"; key: string; dir: string }
  | { type: "relevance"; retrievers?: RetrieverPlan };

/** S2/S4：多路召回计划 */
export interface RetrieverPlan {
  retrievers: WeightedRetriever[];
  /** rrf（默认）| linear */
  fusion?: "rrf" | "linear";
}

export interface WeightedRetriever {
  weight: number;
  kind: { type: "fts"; query: string; scope: SearchScopeLike } | { type: "tagAlias"; text: string; facetKey?: string | null };
}

/** FTS 检索范围（与后端 SearchScope 对齐） */
export type SearchScopeLike = "all" | "content" | "description" | "fileName";

/** S1/S6：完整搜索计划 —— 超级搜索持久化/执行的单一结构（三个版本号随行） */
export interface SearchPlanV3 {
  planSchemaVersion: number;
  normalizationVersion: number;
  compilerVersion: number;
  /** 硬性必须满足（QueryExpr） */
  filter: QueryExpr | null;
  /** 硬性排除 */
  mustNot: QueryExpr | null;
  /** 加权可选：满足则加分 */
  should: ShouldClause[];
  /** 至少命中几条 should 才进结果 */
  minimumShouldMatch: number;
  retrievers: RetrieverPlan;
  ranking: Ranking;
}

/** 已解析标签（AI 解析结果内：tagId → 名称/分面，供 chips 可读展示） */
export interface ResolvedTag {
  facetKey: string;
  text: string;
  tagId: number;
  path: string;
}

/** C-2/U-6：AST 命中诊断 —— 单个叶子条件的 4 指标（后端 diagnose_search_plan_cmd 返回） */
export interface LeafDiagnostic {
  path: number[];
  label: string;
  /** ① 该条件单独执行的命中数 */
  selfCount: number;
  /** ② 完整表达式的命中数（所有叶子共享同一个值） */
  resultCount: number;
  /** ③ 把该叶子从 AST 中移除后的命中数 */
  countWithoutLeaf: number;
  /** ④ delta = countWithoutLeaf - resultCount（AND 下=砍掉多少；OR 下=贡献；NOT 下反转） */
  delta: number;
}

/** C-2/U-6：should（加分项）诊断 —— 命中该加分项的素材数 / 结果总数 */
export interface ShouldDiagnostic {
  label: string;
  hitCount: number;
  totalCount: number;
}

export interface SearchDiagnostics {
  leaves: LeafDiagnostic[];
  should: ShouldDiagnostic[];
}

/** FB5-05（§9.5）+ S1/S3：AI 解析结果。expr 为必须部分唯一执行事实源；
 *  plan 在存在加分项时返回（U 波次三段式 UI 直接映射）。 */
export interface AiSearchParseResult {
  intent: SearchIntentV3;
  expr: QueryExpr | null;
  /** S3：完整计划（含 should 加分）；无加分项时也存在（filter/must_not 恒等） */
  plan?: SearchPlanV3 | null;
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
