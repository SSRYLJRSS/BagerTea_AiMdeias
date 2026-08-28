/**
 * 素材类型判断纯函数（指导书 B-4）：视频识别 MIME 优先，时长兜底，扩展名最后兜底。
 * durationMs 只用于显示时长，不作为唯一类型判断依据（导入时长读取失败时为 null）。
 */
import type { Asset } from "@/types/asset";

const VIDEO_EXTS = new Set([
  "mp4", "mov", "avi", "mkv", "webm", "m4v", "wmv", "flv", "mpg", "mpeg", "3gp", "ts", "vob", "rm", "rmvb",
]);

/** 判断是否为视频：MIME 为 video/*；否则有 durationMs；最后以扩展名兜底。 */
export function isVideoAsset(asset: Pick<Asset, "mimeType" | "durationMs" | "fileExt">): boolean {
  if (asset.mimeType?.startsWith("video/")) return true;
  if (asset.durationMs != null) return true;
  return VIDEO_EXTS.has(asset.fileExt?.toLowerCase() ?? "");
}

/** 判断是否为图片（非视频即视为图片，含 RAW/TIFF/HEIC 等）。 */
export function isImageAsset(asset: Pick<Asset, "mimeType" | "durationMs" | "fileExt">): boolean {
  return !isVideoAsset(asset);
}

/**
 * FB2-07：判断 MIME/路径是否为视频（供 suggestion 等没有完整 Asset 对象的场景用）。
 * 与 isVideoAsset 的判断口径一致（MIME video/* 优先，扩展名兜底），避免两处重复正则。
 */
export function isVideoLike(mimeType: string | null | undefined, pathOrName: string): boolean {
  if (mimeType?.startsWith("video/")) return true;
  const ext = (pathOrName.split(".").pop() ?? "").toLowerCase();
  return VIDEO_EXTS.has(ext);
}
