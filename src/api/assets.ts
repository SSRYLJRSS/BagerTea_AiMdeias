/** 素材相关命令封装（对应 commands/assets_cmd.rs） */
import { invoke } from "./client";
import type { Asset, AssetFilter, AssetPage } from "@/types/asset";

export type DeleteStrategy = "remove_from_library" | "delete_file";

/** B02/B03：删除结果——deleted 为已从库删除数，failedFiles 为磁盘删除失败的 asset id */
export interface DeleteResult {
  deleted: number;
  failedFiles: number[];
}

export function listAssets(filter: AssetFilter): Promise<AssetPage> {
  return invoke<AssetPage>("list_assets", { filter });
}

/** 取当前筛选结果的全部 id（全选/反选/批量操作用；只返回 id 数组，
 *  不拉完整 Asset，不触发 asset 协议放行） */
export function listAssetIds(filter: AssetFilter): Promise<number[]> {
  return invoke<number[]>("list_asset_ids", { filter });
}

export function getAsset(id: number): Promise<Asset> {
  return invoke<Asset>("get_asset", { id });
}

/** 删除双策略（PRD R-10）：仅移出库 / 连同原文件删除
 *  B02/B03：返回 DeleteResult，含磁盘删除失败的 id（delete_file 策略下失败的不从库删） */
export function deleteAssets(ids: number[], strategy: DeleteStrategy): Promise<DeleteResult> {
  return invoke<DeleteResult>("delete_assets", { ids, strategy });
}

/** 取原文件路径（用于系统打开/复制链接等） */
export function getAssetUrls(ids: number[]): Promise<string[]> {
  return invoke<string[]>("get_asset_urls", { ids });
}
