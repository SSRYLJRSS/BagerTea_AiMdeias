/** 标签（父子层级·方案B） */

export interface Tag {
  id: number;
  name: string;
  canonicalName: string;
  normalizedName: string;
  facetKey: string;
  parentId: number | null;
  status: "active" | "deprecated" | "blocked";
  isSystem: boolean;
  isPreset: boolean;
  sortOrder: number;
  /** 自身直接关联素材数 */
  assetCount: number;
  /** 自身+后代合计（父标签显示值） */
  totalCount: number;
  aliases: string[];
  path: string;
  /** F4：所在分面生命周期是否有效（存在且 active）。UI 打「已停用」角标 */
  facetEffective: boolean;
}

export interface TagFacet {
  key: string;
  displayName: string;
  description: string;
  /** W3-1：V20 合表后新增——ai_and_manual = 参与 AI 打标；manual_only = 只手工填写 */
  inputMode: "ai_and_manual" | "manual_only";
  selectionMode: "single" | "multi";
  maxItems: number | null;
  sortOrder: number;
  isSystem: boolean;
  status: "active" | "inactive" | "deprecated";
  appliesTo: "all" | "image" | "video";
  createdAt: number;
  updatedAt: number;
}

/** W2-4：分面影响范围（与后端 FacetImpact 对齐；aiConfigCount 已随 V20 合表删除）。
 *  R3-3：新增 aliasCount —— delete_facet 会连带删 tag_aliases，报告须覆盖。 */
export interface TagFacetImpact {
  tagCount: number;
  assetCount: number;
  aiSuggestionItemCount: number;
  tagOpCount: number;
  aliasCount: number;
}

/** 打标工作台分面：V20 合表后 tag_facets 单一事实源（inputMode 分组取代 enabledForAi）。 */
export interface WorkbenchFacet {
  key: string;
  displayName: string;
  description: string;
  inputMode: "ai_and_manual" | "manual_only";
  selectionMode: "single" | "multi";
  maxItems: number | null;
}

export interface TagFacetGovernance {
  facetKey: string;
  tagCount: number;
  activeTagCount: number;
  deprecatedTagCount: number;
  linkedAssetCount: number;
  aliasCount: number;
  pendingAiItemCount: number;
}

export interface TagNode {
  tag: Tag;
  children: TagNode[];
}
