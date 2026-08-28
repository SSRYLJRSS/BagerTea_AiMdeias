/**
 * 悬停预览播放语义（FB2-03）：播「前几秒」而不是整段。
 * startAt = min(duration * 0.1, 2s) —— 跳过片头黑场/淡入（相机视频开头常全黑/曝光未稳）。
 * 用 timeupdate 回跳实现片段循环而非 loop 属性 —— loop 播整段，这里只播一个片段。
 * 属性保持 muted + playsInline + preload="metadata"。
 */
import { useEffect, useRef } from "react";

export interface HoverPreviewOptions {
  /** 预览时长（秒），来自 appearance.hoverPreview.previewSeconds */
  previewSeconds: number;
  /** 播放失败回调（上层决定：素材库走代理重试，入库页退回封面） */
  onFailed: () => void;
}

export function useHoverPreviewPlayback(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  opts: HoverPreviewOptions,
): void {
  // previewSeconds 用 ref 持有，变化不重挂 effect —— 避免用户拖数字时反复重载视频
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    // 主动释放标志：清 src 后 load() 会触发 error，须跳过错误回调
    let released = false;
    let startAt = 0;

    const onMeta = () => {
      try {
        const dur = v.duration;
        startAt =
          Number.isFinite(dur) && dur > 0 ? Math.min(dur * 0.1, 2) : 0;
      } catch {
        startAt = 0;
      }
      v.currentTime = startAt;
      const p = v.play() as unknown;
      if (p && typeof (p as Promise<void>).then === "function") {
        (p as Promise<void>).catch(() => {
          if (!released) optsRef.current.onFailed();
        });
      }
    };

    const onTime = () => {
      if (released) return;
      const limit = startAt + optsRef.current.previewSeconds;
      if (v.currentTime >= limit && Number.isFinite(limit)) v.currentTime = startAt;
    };

    // 媒体加载/解码失败（如编码不兼容）→ 交给上层兜底（素材库走代理重试，入库页退回封面）
    const onError = () => {
      if (!released) optsRef.current.onFailed();
    };

    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("error", onError);

    return () => {
      released = true;
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("error", onError);
      v.pause();
      v.removeAttribute("src");
      void v.load();
    };
  }, [videoRef]);
}