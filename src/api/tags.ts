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

export function assignTags(assetIds: number[], tagIds: number[]): Promise<void> {
  return invoke<void>("assign_tags", { assetIds, tagIds });
}

export function removeTags(assetIds: number[], tagIds: number[]): Promise<void> {
  return invoke<void>("remove_tags", { assetIds, tagIds });
}

export function getAssetTags(assetId: number): Promise<Tag[]> {
  return invoke<Tag[]>("get_asset_tags", { assetId });
}
