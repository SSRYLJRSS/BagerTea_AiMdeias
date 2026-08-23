/** 标签相关命令封装（对应 commands/tags_cmd.rs） */
import { invoke } from "./client";
import type { Tag, TagNode } from "@/types/tag";

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

/** 合并标签：src 的素材关联与子标签并入 dst，随后删除 src（M3-01） */
export function mergeTags(srcId: number, dstId: number): Promise<void> {
  return invoke<void>("tag_merge", { srcId, dstId });
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
