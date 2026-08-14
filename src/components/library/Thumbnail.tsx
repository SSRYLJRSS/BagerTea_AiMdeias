/** 双层缩略图：占位图立即显示，进入可见区后按需生成高清并淡入替换（PRD R-01） */
import { memo, useEffect, useRef, useState } from "react";
import { getThumbnailUrl, toFileUrl } from "@/api/thumbnail";

interface ThumbnailProps {
  assetId: number;
  placeholderPath: string | null;
  alt: string;
}

export default memo(function Thumbnail({ assetId, placeholderPath, alt }: ThumbnailProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [hdUrl, setHdUrl] = useState<string | null>(null);
  const [hdReady, setHdReady] = useState(false);
  const [placeholderUrl, setPlaceholderUrl] = useState<string | null>(
    placeholderPath ? toFileUrl(placeholderPath) : null,
  );
  const [placeholderFailed, setPlaceholderFailed] = useState(false); // B27：占位图加载失败标记

  // 占位图路径后到时补转 URL（入库刚完成的行）
  useEffect(() => {
    if (!placeholderUrl && placeholderPath) setPlaceholderUrl(toFileUrl(placeholderPath));
  }, [placeholderPath, placeholderUrl]);

  // B27：占位图加载失败 → 触发 hd 生成（原逻辑 hd 只在 hdUrl 为 null 时触发，现补充占位图失败也触发）
  useEffect(() => {
    if (placeholderFailed && !hdUrl) {
      getThumbnailUrl(assetId, "hd", 512)
        .then(setHdUrl)
        .catch(() => undefined);
    }
  }, [placeholderFailed, hdUrl, assetId]);

  // 可见区触发高清生成（IntersectionObserver，离开不取消——生成结果已缓存）
  useEffect(() => {
    const el = rootRef.current;
    if (!el || hdUrl) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          getThumbnailUrl(assetId, "hd", 512)
            .then(setHdUrl)
            .catch(() => undefined); // 高清失败保留占位图
        }
      },
      { rootMargin: "200px" }, // 提前一屏预生成，滚动无感
    );
    io.observe(el);
    return () => io.disconnect();
  }, [assetId, hdUrl]);

  return (
    <div ref={rootRef} className="absolute inset-0 bg-[var(--color-surface)]">
      {placeholderUrl && !placeholderFailed ? (
        <img
          src={placeholderUrl}
          alt={alt}
          draggable={false}
          onError={() => setPlaceholderFailed(true)} // B27：占位图失败回退到 pulse 占位
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 animate-pulse bg-[var(--color-border)]" />
      )}
      {hdUrl && (
        <img
          src={hdUrl}
          alt=""
          aria-hidden
          draggable={false}
          onLoad={() => setHdReady(true)}
          className="absolute inset-0 h-full w-full object-cover transition-opacity duration-300"
          style={{ opacity: hdReady ? 1 : 0 }}
        />
      )}
    </div>
  );
});
