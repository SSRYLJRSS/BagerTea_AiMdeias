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
}

export interface TagFacet {
  key: string;
  displayName: string;
  description: string;
  selectionMode: "single" | "multi";
  maxItems: number | null;
  sortOrder: number;
  isSystem: boolean;
  status: "active" | "deprecated";
}

/** 打标工作台分面（指导书 §9.2）：tag_facets 唯一决定结构；aiFacetConfigs 只覆盖
 *  enabledForAi / hint / 可选显示名。tagCategories 不再作为业务渲染数据源。 */
export interface WorkbenchFacet {
  key: string;
  displayName: string;
  description: string;
  selectionMode: "single" | "multi";
  maxItems: number | null;
  enabledForAi: boolean;
  hint: string;
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
