/** 图片悬浮预览内容（指导书阶段 4 §7.3）：已有 placeholder 先显示，再请求 1024px hover 预览；
 *  加载失败显示类型占位 + 轻量错误文案，不阻塞。 */
import { useEffect, useState } from "react";
import clsx from "clsx";

interface ImagePreviewContentProps {
  /** 1100px hover 预览 URL（可能为 null，表示尚未生成/失败） */
  url: string | null;
  /** 已入库素材的占位图路径（就地转协议 URL） */
  placeholderUrl: string | null;
  fileName: string;
  className?: string;
}

export default function ImagePreviewContent({ url, placeholderUrl, fileName, className }: ImagePreviewContentProps) {
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [url]);

  const showPreview = url && !failed;

  return (
    <div className={clsx("relative h-64 w-full overflow-hidden bg-[var(--color-surface)]", className)}>
      {showPreview && (
        <img src={url} alt={fileName} className="h-full w-full object-contain" onError={() => setFailed(true)} />
      )}
      {!showPreview && placeholderUrl && (
        <img src={placeholderUrl} alt={fileName} className="h-full w-full object-contain" />
      )}
      {!showPreview && !placeholderUrl && (
        <div className="flex h-full w-full items-center justify-center text-[10px] text-[var(--color-text-secondary)]">
          图片
        </div>
      )}
      {failed && (
        <p className="absolute inset-x-0 bottom-0 bg-black/40 px-2 py-0.5 text-center text-[10px] text-[var(--color-success)]">
          预览加载失败
        </p>
      )}
    </div>
  );
}
