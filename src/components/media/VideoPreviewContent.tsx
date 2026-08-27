/** 视频悬浮预览内容（指导书阶段 4 §7.4 + F-4）三级策略：
 *  ① 封面放大（零转码，显示播放角标）→ ② 原视频静音短播（muted/playsInline，只播前 5 秒，
 *  失败即降级回封面）→ ③ 代理预览（默认关闭，由上层传入 proxyUrl；无则跳过）。
 *  F-4：删除内部额外 250ms 延迟——内容组件只在悬浮 active 时才被渲染，挂载即播，
 *  避免与悬浮触发器的 300ms 进入延迟叠加成双重延迟。 */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";

interface VideoPreviewContentProps {
  /** 原视频 URL（asset 协议） */
  src: string;
  /** 封面/首帧 URL（可能 null） */
  coverUrl: string | null;
  /** 代理预览 URL（默认 null = 未启用，跳过第 3 级） */
  proxyUrl?: string | null;
  fileName: string;
  className?: string;
}

const PLAY_LIMIT_MS = 5000;

export default function VideoPreviewContent({ src, coverUrl, proxyUrl = null, fileName, className }: VideoPreviewContentProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // F-4：内容组件在悬浮 active 时才渲染，挂载即播——不再有内部 250ms「封面→视频」延迟
  const [vidError, setVidError] = useState(false);

  useEffect(() => {
    if (vidError) return;
    const v = videoRef.current;
    if (!v) return;
    const onErr = () => setVidError(true);
    const onLoaded = () => {
      v.currentTime = 0;
      void v.play().catch(() => setVidError(true));
    };
    v.addEventListener("error", onErr);
    v.addEventListener("loadedmetadata", onLoaded);
    const stop = setTimeout(() => v.pause(), PLAY_LIMIT_MS);
    return () => {
      v.removeEventListener("error", onErr);
      v.removeEventListener("loadedmetadata", onLoaded);
      clearTimeout(stop);
      v.pause();
    };
  }, [vidError]);

  // 失败时降级回封面；保持「原视频播放失败会降级」
  const showVideo = !vidError;
  const display = (proxyUrl && showVideo) ? proxyUrl : (showVideo ? src : null);

  return (
    <div className={clsx("relative h-64 w-full overflow-hidden bg-black", className)}>
      {showVideo && !vidError ? (
        <video
          ref={videoRef}
          src={display ?? src}
          muted
          playsInline
          autoPlay
          className="h-full w-full object-contain"
          onError={() => setVidError(true)}
        />
      ) : (
        <div className="relative h-full w-full">
          {coverUrl ? (
            <img src={coverUrl} alt={fileName} className="h-full w-full object-contain" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-[10px] text-[var(--color-text-secondary)]">
              视频
            </div>
          )}
          <span className="absolute top-2 left-2 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white">▶ 预览</span>
        </div>
      )}
    </div>
  );
}
