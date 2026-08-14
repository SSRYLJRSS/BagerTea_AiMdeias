/** 缩略图命令封装（对应 commands/thumbnail_cmd.rs）+ 路径转协议 URL */
import { convertFileSrc } from "@tauri-apps/api/core";
import { invoke } from "./client";

export type ThumbnailKind = "placeholder" | "hd";

/** 取缩略图本地路径；kind=hd 时按需生成并缓存（二次调用命中） */
export function getThumbnailPath(assetId: number, kind: ThumbnailKind, size?: number): Promise<string> {
  return invoke<string>("get_thumbnail", { assetId, kind, size });
}

/** 直接取可渲染 URL（convertFileSrc 走 asset 协议） */
export async function getThumbnailUrl(assetId: number, kind: ThumbnailKind, size?: number): Promise<string> {
  return convertFileSrc(await getThumbnailPath(assetId, kind, size));
}

/** 已有本地路径（Asset.placeholderPath 等）时直接转 URL，零 IPC */
export function toFileUrl(path: string): string {
  return convertFileSrc(path);
}

export function clearThumbnailCache(kind?: ThumbnailKind): Promise<void> {
  return invoke<void>("clear_thumbnail_cache", { kind });
}
