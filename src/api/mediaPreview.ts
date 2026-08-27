/** 悬浮预览资源接口（指导书阶段 4 §7.3/§7.4）：
 *  - 图片 hover 预览：已有 placeholder → 已有 512px/HD 缓存 → 请求 1024px hover 预览（同一素材同一尺寸只请求一次）；
 *  - 视频代理预览：默认关闭（仅设置开启且后端命令存在时才生成），本模块返回 null。 */
import { getThumbnailUrl } from "@/api/thumbnail";

// 模块级缓存：同一素材同一尺寸只请求一次（含失败），不重复解码/生成
const imgCache = new Map<string, Promise<string | null>>();

/** 图片 hover 预览 URL（1024px，按需生成并命中缓存）；失败返回 null 由 UI 显示占位 */
export function getImageHoverPreview(assetId: number, size = 1024): Promise<string | null> {
  const key = `img:${assetId}:${size}`;
  let p = imgCache.get(key);
  if (!p) {
    p = getThumbnailUrl(assetId, "hd", size)
      .then((u) => (u ? u : null))
      .catch(() => null);
    imgCache.set(key, p);
  }
  return p;
}

/** 视频代理预览（水平 3，指导书 §7.4）：默认关闭，返回 null。
 *  仅当设置「生成视频代理预览」开启且后端代理命令可用时才返回 URL；
 *  尚无后端实现 → 恒 null（UI 自动降级到封面放大 / 原视频静音短播）。 */
export async function getVideoProxyPreview(_assetId: number): Promise<string | null> {
  return null;
}

/** 清空悬停预览缓存（清理缓存命令时调用） */
export function clearHoverPreviewCache(): void {
  imgCache.clear();
}
