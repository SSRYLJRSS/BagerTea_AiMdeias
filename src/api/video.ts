/** 视频兼容代理命令封装（对应 commands/video_cmd.rs，指导书 §8.3） */
import { invoke } from "./client";
import { convertFileSrc } from "@tauri-apps/api/core";

export type VideoProxyStatus = "queued" | "running" | "ready" | "failed" | "canceled";

export interface VideoProxy {
  assetId: number;
  variant: string;
  status: VideoProxyStatus;
  path: string | null;
  error: string | null;
  updatedAt: number;
}

/** 确保生成平台默认的兼容代理；编码变体由 Rust 能力层选择。 */
export function ensureVideoProxy(assetId: number, variant?: string): Promise<VideoProxy> {
  return invoke<VideoProxy>("ensure_video_proxy", { assetId, variant });
}

export function getVideoProxyStatus(assetId: number, variant?: string): Promise<VideoProxy | null> {
  return invoke<VideoProxy | null>("get_video_proxy_status", { assetId, variant });
}

export function cancelVideoProxy(assetId: number, variant?: string): Promise<void> {
  return invoke<void>("cancel_video_proxy", { assetId, variant });
}

export function clearVideoProxy(assetId: number): Promise<void> {
  return invoke<void>("clear_video_proxy", { assetId });
}

/** 代理路径（绝对路径）→ asset 协议可渲染 URL。 */
export function toProxyFileUrl(path: string): string {
  return convertFileSrc(path);
}

/** §6.7 代理缓存统计：ready 文件数 + 磁盘占用字节。 */
export function videoProxyCacheStats(): Promise<[number, number]> {
  return invoke<[number, number]>("video_proxy_cache_stats");
}

/** §6.7 清理全部视频代理缓存（不影响原文件）；返回删除文件数。 */
export function clearAllVideoProxies(): Promise<number> {
  return invoke<number>("clear_all_video_proxies");
}
