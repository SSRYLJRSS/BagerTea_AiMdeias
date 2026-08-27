/**
 * 缩略图前端缓存（指导书 §9.2/§9.3）：
 *  - 模块级 `Map<assetId:kind:size, CacheEntry>`，跨虚拟滚动重挂载共享；
 *  - 状态机 idle | loading | ready | failed；同一 asset+size 只发起一个请求 Promise（single-flight 前端侧）；
 *  - 命中 ready 直接复用 URL；failed 短暂退避，避免 onError 与 observer 之间无限重试；
 *  - 组件卸载/切张后的旧 Promise 不得更新新素材（由组件侧 generation 保护）。
 */
import { getThumbnailUrl } from "@/api/thumbnail";
import type { ThumbnailKind } from "@/api/thumbnail";

export interface ThumbnailCacheEntry {
  url: string | null;
  status: "idle" | "loading" | "ready" | "failed";
  promise?: Promise<string>;
  at: number;
  error?: string;
}

/** 失败退避窗口：避免滚动时对同一素材无限重试（§9.2） */
const FAIL_BACKOFF_MS = 5000;

const cache = new Map<string, ThumbnailCacheEntry>();

function key(assetId: number, kind: ThumbnailKind, size: number): string {
  return `${assetId}:${kind}:${size}`;
}

/** 读取缓存条目（只读；不存在返回 undefined）。 */
export function getCachedThumbnail(assetId: number, kind: ThumbnailKind, size: number): ThumbnailCacheEntry | undefined {
  return cache.get(key(assetId, kind, size));
}

/** 请求高清缩略图 URL：命中 ready 直接返回；loading 复用 promise；failed 在退避窗口内快速失败。
 *  writeThumb 在组件里命中 ready 缓存时直接显示并跳过重复淡入。
 */
export function requestThumbnail(assetId: number, kind: ThumbnailKind, size: number): Promise<string> {
  const k = key(assetId, kind, size);
  const existing = cache.get(k);
  if (existing?.status === "ready" && existing.url) return Promise.resolve(existing.url);
  if (existing?.promise) return existing.promise;
  if (existing?.status === "failed" && Date.now() - existing.at < FAIL_BACKOFF_MS) {
    return Promise.reject(new Error(existing.error ?? "缩略图失败，稍后重试"));
  }

  const entry: ThumbnailCacheEntry = { url: null, status: "loading", at: Date.now() };
  cache.set(k, entry);
  const p = getThumbnailUrl(assetId, kind, size)
    .then((url) => {
      entry.status = "ready";
      entry.url = url;
      entry.at = Date.now();
      return url;
    })
    .catch((e: unknown) => {
      entry.status = "failed";
      entry.error = e instanceof Error ? e.message : String(e);
      entry.at = Date.now();
      throw e;
    });
  entry.promise = p;
  return p;
}

/** 手动标记失败（例如图片 onError 兜底时同步更新缓存，避免下次重挂载再请求）。 */
export function markThumbnailFailed(assetId: number, kind: ThumbnailKind, size: number, error?: string): void {
  cache.set(key(assetId, kind, size), { url: null, status: "failed", at: Date.now(), error });
}

/** 清空前端缓存（与后端清缓存联动，供 settings 里「清除缓存」调用）。 */
export function clearThumbnailCache(): void {
  cache.clear();
}
