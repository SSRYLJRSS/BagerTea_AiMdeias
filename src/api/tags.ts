/** 标签相关命令封装（对应 commands/tags_cmd.rs） */
import { invoke } from "./client";
import type { Tag, TagFacet, TagFacetGovernance, TagFacetImpact, TagNode } from "@/types/tag";

export function listTagFacets(): Promise<TagFacet[]> {
  return invoke<TagFacet[]>("list_tag_facets");
}

/** 分面管理：列出全部（含 inactive）。 */
export function listAllTagFacets(): Promise<TagFacet[]> {
  return invoke<TagFacet[]>("list_all_tag_facets");
}

/** 分面管理：创建用户分面（key 稳定不可改）。 */
export function createTagFacet(input: {
  key: string;
  displayName: string;
  description?: string;
  selectionMode: "single" | "multi";
  maxItems?: number | null;
  appliesTo?: "all" | "image" | "video";
}): Promise<TagFacet> {
  return invoke<TagFacet>("create_tag_facet", {
    key: input.key,
    displayName: input.displayName,
    description: input.description ?? "",
    selectionMode: input.selectionMode,
    maxItems: input.maxItems ?? null,
    appliesTo: input.appliesTo ?? "all",
  });
}

/** W2-2/W4：合并编辑命令（6 字段一个事务；替代 display/rules 两个旧命令） */
export function updateTagFacet(input: {
  key: string;
  displayName: string;
  description: string;
  inputMode: "ai_and_manual" | "manual_only";
  selectionMode: "single" | "multi";
  maxItems?: number | null;
  appliesTo: "all" | "image" | "video";
}): Promise<void> {
  return invoke<void>("update_tag_facet", {
    key: input.key,
    displayName: input.displayName,
    description: input.description,
    inputMode: input.inputMode,
    selectionMode: input.selectionMode,
    maxItems: input.maxItems ?? null,
    appliesTo: input.appliesTo,
  });
}

/** W2-3/W4：删除报告（与确认弹窗的数字对账） */
export interface FacetDeleteReport {
  tagsDeleted: number;
  unlinked: number;
  opsDeleted: number;
  itemsDeleted: number;
}

/** W2-3/W4：物理删除分面 + 全级联（系统分面拒绝） */
export function deleteTagFacet(key: string): Promise<FacetDeleteReport> {
  return invoke<FacetDeleteReport>("delete_tag_facet", { key });
}

export function updateTagFacetDisplay(key: string, displayName: string, description?: string): Promise<void> {
  return invoke<void>("update_tag_facet_display", { key, displayName, description: description ?? "" });
}

export function updateTagFacetRules(
  key: string,
  selectionMode: "single" | "multi",
  maxItems?: number | null,
  appliesTo?: "all" | "image" | "video",
): Promise<void> {
  return invoke<void>("update_tag_facet_rules", {
    key,
    selectionMode,
    maxItems: maxItems ?? null,
    appliesTo: appliesTo ?? "all",
  });
}

export function reorderTagFacets(orderedKeys: string[]): Promise<void> {
  return invoke<void>("reorder_tag_facets", { orderedKeys });
}

export function deactivateTagFacet(key: string): Promise<void> {
  return invoke<void>("deactivate_tag_facet", { key });
}

export function restoreTagFacet(key: string): Promise<void> {
  return invoke<void>("restore_tag_facet", { key });
}

export function getTagFacetImpact(key: string): Promise<TagFacetImpact> {
  return invoke<TagFacetImpact>("get_tag_facet_impact", { key });
}

export function listTagsByFacet(facetKey: string): Promise<TagNode[]> {
  return invoke<TagNode[]>("list_tags_by_facet", { facetKey });
}

export function listTagGovernance(): Promise<TagFacetGovernance[]> {
  return invoke<TagFacetGovernance[]>("list_tag_governance");
}

export function searchTagCandidates(facetKey: string | null, query: string): Promise<Tag[]> {
  return invoke<Tag[]>("search_tag_candidates", { facetKey: facetKey ?? undefined, query });
}

export function createCanonicalTag(name: string, facetKey: string, parentId: number | null): Promise<Tag> {
  return invoke<Tag>("create_canonical_tag", { name, facetKey, parentId });
}

export function addTagAlias(tagId: number, alias: string, locale?: string): Promise<void> {
  return invoke<void>("add_tag_alias", { tagId, alias, locale });
}

export function listTags(): Promise<TagNode[]> {
  return invoke<TagNode[]>("list_tags");
}

export function createTag(name: string, parentId: number | null): Promise<Tag> {
  return invoke<Tag>("create_tag", { name, parentId });
}

/** parentId 传 undefined 表示不动；传 null 表示移到顶级 */
export function updateTag(id: number, name?: string, parentId?: number | null): Promise<void> {
  return invoke<void>("update_tag", { id, name, parentId });
}

export function deleteTag(id: number): Promise<void> {
  return invoke<void>("delete_tag", { id });
}

export function deactivateTag(id: number): Promise<void> {
  return invoke<void>("deactivate_tag", { id });
}

/** 合并标签：src 的素材关联与子标签并入 dst，随后删除 src（M3-01） */
export function mergeTags(srcId: number, dstId: number): Promise<void> {
  return invoke<void>("merge_tags_preserve_alias", { srcId, dstId });
}

export function assignTags(assetIds: number[], tagIds: number[]): Promise<void> {
  return invoke<void>("assign_tags", { assetIds, tagIds });
}

export function removeTags(assetIds: number[], tagIds: number[]): Promise<void> {
  return invoke<void>("remove_tags", { assetIds, tagIds });
}

/** R-25 最近打标流水（打标页「最近打标」列表） */
export function recentTagOps(limit = 100): Promise<import("@/types/asset").TagOp[]> {
  return invoke<import("@/types/asset").TagOp[]>("tag_recent_ops", { limit });
}

/** R-25 批次撤销：按流水反向操作，返回实际生效条数 */
export function undoTagBatch(batchId: number): Promise<number> {
  return invoke<number>("tag_undo_batch", { batchId });
}

/** 一句话描述列表（标签与分类设置页展示；描述走 FTS 模糊搜索） */
export interface ContentDescription {
  assetId: number;
  fileName: string;
  description: string;
}

export function listContentDescriptions(limit?: number): Promise<ContentDescription[]> {
  return invoke<ContentDescription[]>("list_content_descriptions", { limit });
}

// ── F2-e：标签数据完整性（V22b 约束能力）──

/** 单个约束能力状态 */
export interface SchemaFeatureStatus {
  feature: string;
  enabled: boolean;
  appliedAt: number | null;
  blockedBy: string | null;
}

/** term 冲突组（设置页「处理冲突」展示） */
export interface TermConflictGroup {
  facetKey: string;
  term: string;
  entries: { tagId: number; name: string; kind: string; linkedAssets: number }[];
}

/** V22b 预检报告（六类冲突） */
export interface TagConflictReport {
  termConflicts: TermConflictGroup[];
  orphans: { id: number; name: string; facetKey: string }[];
  crossFacetChildren: { id: number; name: string; parentId: number; ownFacet: string; parentFacet: string }[];
  cycleEdges: { id: number; name: string; parentId: number | null }[];
  overDeepSubtrees: number[];
  facetMismatches: { tagId: number; tagName: string; termsFacet: string; tagFacet: string }[];
}

/** 读取能力状态 */
export function listTagConstraintFeatures(): Promise<SchemaFeatureStatus[]> {
  return invoke<SchemaFeatureStatus[]>("list_tag_constraint_features");
}

/** 预检冲突（只读） */
export function detectTagConstraintsConflicts(): Promise<TagConflictReport> {
  return invoke<TagConflictReport>("detect_tag_constraints_conflicts");
}

/** 启用约束（预检必须干净） */
export function applyTagConstraints(): Promise<void> {
  return invoke<void>("apply_tag_constraints");
}
