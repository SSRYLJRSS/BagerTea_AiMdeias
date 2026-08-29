/** 素材相关命令封装（对应 commands/assets_cmd.rs） */
import { invoke } from "./client";
import type { Asset, AssetFilter, AssetPage, DupGroup, MetadataFacet } from "@/types/asset";

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

/** 文件自身携带的格式、时间、设备和拍摄参数分面。 */
export function listMetadataFacets(): Promise<MetadataFacet[]> {
  return invoke<MetadataFacet[]>("list_metadata_facets");
}

export function getAsset(id: number): Promise<Asset> {
  return invoke<Asset>("get_asset", { id });
}

/** 删除双策略（PRD R-10）：仅移出库 / 连同原文件删除
 *  B02/B03：返回 DeleteResult，含磁盘删除失败的 id（delete_file 策略下失败的不从库删） */
export function deleteAssets(ids: number[], strategy: DeleteStrategy): Promise<DeleteResult> {
  return invoke<DeleteResult>("delete_assets", { ids, strategy });
}

/** 重复素材扫描（M3-02 R-20）：hash 精确分组 */
export function scanDuplicates(): Promise<DupGroup[]> {
  return invoke<DupGroup[]>("dedup_scan");
}

/** R-22 回收站恢复：返回实际恢复条数 */
export function trashRestore(ids: number[]): Promise<number> {
  return invoke<number>("trash_restore", { ids });
}

/** 取原文件路径（用于系统打开/复制链接等） */
export function getAssetUrls(ids: number[]): Promise<string[]> {
  return invoke<string[]>("get_asset_urls", { ids });
}

/** 在资源管理器中打开素材所在文件夹（右键菜单，B24 后端校验路径归属） */
export function revealInFolder(path: string): Promise<void> {
  return invoke<void>("reveal_in_folder", { path });
}

// ── 媒体元数据回填（指导书 §7.5）──

export interface RescanResult {
  total: number;
  success: number;
  failed: number;
  skipped: number;
}

export interface RefillProgress {
  done: number;
  total: number;
  success: number;
  failed: number;
  skipped: number;
  currentId: number;
}

/** 回填范围：all=全部视频 | missing=仅缺字段 | ids=选中素材 */
export function rescanAssetMetadata(ids: number[], scope: "all" | "missing" | "ids"): Promise<RescanResult> {
  return invoke<RescanResult>("rescan_asset_metadata", { ids, scope });
}

/** FB2-08：算法色板回算（不调用 AI）。范围：all=全部可算素材 | missing=仅缺色板 | ids=选中素材 */
export function rescanAssetPalette(
  ids: number[],
  scope: "all" | "missing" | "ids",
): Promise<RescanResult> {
  return invoke<RescanResult>("rescan_asset_palette", { ids, scope });
}

export function cancelMediaRefill(): Promise<void> {
  return invoke<void>("cancel_media_refill");
}
