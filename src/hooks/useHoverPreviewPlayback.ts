/**
 * 悬停预览播放语义（FB2-03）：播「前几秒」而不是整段。
 * startAt = min(duration * 0.1, 2s) —— 跳过片头黑场/淡入（相机视频开头常全黑/曝光未稳）。
 * 用 timeupdate 回跳实现片段循环而非 loop 属性 —— loop 播整段，这里只播一个片段。
 * 属性保持 muted + playsInline + preload="metadata"。
 */
import { useLayoutEffect, useRef } from "react";

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

  useLayoutEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    // 主动释放标志：effect 清理时会暂停播放，须跳过异步回调。
    let released = false;
    let startAt = 0;
    let sourceKey = v.currentSrc || v.src;
    let playbackStarted = false;
    let failureReported = false;

    const currentSource = () => v.currentSrc || v.src;

    const resetSourceState = () => {
      sourceKey = currentSource();
      startAt = 0;
      playbackStarted = false;
      failureReported = false;
    };

    const reportFailure = () => {
      if (released || failureReported) return;
      failureReported = true;
      optsRef.current.onFailed();
    };

    const playSegment = () => {
      if (released) return;
      const nextSource = currentSource();
      if (!nextSource) return;
      if (nextSource !== sourceKey) resetSourceState();
      if (playbackStarted) return;

      try {
        const dur = v.duration;
        startAt =
          Number.isFinite(dur) && dur > 0 ? Math.min(dur * 0.1, 2) : 0;
      } catch {
        startAt = 0;
      }

      try {
        v.currentTime = startAt;
      } catch {
        // 某些容器 metadata 已到但暂时不可 seek，仍先尝试从当前位置播放。
      }

      playbackStarted = true;
      let p: unknown;
      try {
        p = v.play() as unknown;
      } catch {
        // 旧版 WebView 可能同步抛出不支持格式，而不是返回 rejected Promise。
        playbackStarted = false;
        reportFailure();
        return;
      }
      if (p && typeof (p as Promise<void>).then === "function") {
        (p as Promise<void>).catch(() => {
          playbackStarted = false;
          reportFailure();
        });
      }
    };

    const onLoadStart = () => resetSourceState();
    const onMeta = () => playSegment();
    const onCanPlay = () => playSegment();
    const onTime = () => {
      if (released) return;
      const seconds = Number(optsRef.current.previewSeconds);
      const previewSeconds = Number.isFinite(seconds) ? Math.max(0.1, seconds) : 3;
      const limit = Number.isFinite(v.duration) && v.duration > 0
        ? Math.min(startAt + previewSeconds, v.duration)
        : startAt + previewSeconds;
      if (v.currentTime >= limit && Number.isFinite(limit) && limit > startAt) {
        try {
          v.currentTime = startAt;
        } catch {
          // 仅在媒体允许 seek 时循环片段；播放失败仍由 error/ended 处理。
        }
      }
    };

    const onEnded = () => {
      if (released) return;
      playbackStarted = false;
      playSegment();
    };

    // 媒体加载/解码失败（如编码不兼容）→ 交给上层兜底（素材库走代理重试，入库页退回封面）
    const onError = () => reportFailure();

    // 用 layout effect 尽早接管事件，并在绑定后补查 readyState/error，
    // 覆盖缓存视频或不兼容编码在 effect 前就发出 loadedmetadata/error 的竞态。
    v.addEventListener("loadstart", onLoadStart);
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("canplay", onCanPlay);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("ended", onEnded);
    v.addEventListener("error", onError);

    if (v.error) {
      reportFailure();
    } else if (v.readyState >= 1) {
      playSegment();
    }

    return () => {
      released = true;
      v.removeEventListener("loadstart", onLoadStart);
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("canplay", onCanPlay);
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("ended", onEnded);
      v.removeEventListener("error", onError);
      try {
        v.pause();
      } catch {
        // jsdom 和部分 WebView 在媒体元素清理阶段可能不支持 pause()。
      }
      // 不在 effect cleanup 中移除 src：React StrictMode 会重放 effect，
      // 清掉 src 会让第二次初始化拿不到媒体源，悬停预览随即失效。
      // 组件卸载后 DOM 会回收媒体资源；抢占场景由 video slot 单独处理。
    };
  }, [videoRef]);
}
