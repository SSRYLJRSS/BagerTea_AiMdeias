/** 待入库文件预览缩略图（PRD v2.6）；失败返回 null 由 UI 显示占位图标 */
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";

// 模块级缓存：同一路径只请求一次（含失败），滚动/切换视图不重复解码
const cache = new Map<string, Promise<string | null>>();

export function getPreviewUrl(path: string): Promise<string | null> {
  let p = cache.get(path);
  if (!p) {
    p = invoke<string | null>("get_preview", { path })
      .then((disk) => (disk ? convertFileSrc(disk) : null))
      .catch(() => null);
    cache.set(path, p);
  }
  return p;
}
