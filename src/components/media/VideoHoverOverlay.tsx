/** 素材卡片内视频悬浮预览（指导书 F）：hover 激活时覆盖原卡片（inset:0）播放，离开即停。
 *  尺寸 = 原卡片（不固定 420px），仅显示/播放；pointer-events:none 不吞卡片单击/双击。
 *  播放生命周期绑定 active（挂载即播、卸载即暂停重置）；播放失败回退封面 + 轻量错误文案。 */
import { useEffect, useRef, useState } from "react";

interface VideoHoverOverlayProps {
  /** 原视频 URL（asset 协议） */
  src: string;
  /** 封面/首帧 URL（可能 null） */
  coverUrl: string | null;
  fileName: string;
}

const PLAY_LIMIT_MS = 5000;

export default function VideoHoverOverlay({ src, coverUrl, fileName }: VideoHoverOverlayProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [vidError, setVidError] = useState(false);

  // 播放生命周期：挂载即播；卸载/离开时暂停、重置到 0（F-4）
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
    const stop = setTimeout(() => v.pause(), PLAY_LIMIT_MS); // 短播上限
    return () => {
      v.removeEventListener("error", onErr);
      v.removeEventListener("loadedmetadata", onLoaded);
      clearTimeout(stop);
      v.pause();
      v.currentTime = 0;
    };
  }, [vidError]);

  return (
    // F-5：pointer-events none，只承担显示/播放，不吞卡片单击/双击；覆盖原卡片
    <div className="absolute inset-0 overflow-hidden rounded-md bg-black" style={{ pointerEvents: "none" }}>
      {!vidError ? (
        <video
          ref={videoRef}
          src={src}
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
              视频不可预览
            </div>
          )}
          <span className="absolute top-1.5 left-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white">
            预览失败
          </span>
        </div>
      )}
    </div>
  );
}
