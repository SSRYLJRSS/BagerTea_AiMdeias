/**
 * MediaViewport（指导书 §4.2）：查看器媒体舞台。
 *  - 图片：Pointer Events 平移/双击缩放/Alt+滚轮锚点缩放/左键缩放后拖拽/中键兼容平移；
 *  - ViewState 状态机 idle|panning|temporaryZoom；缩放 0.2–8，初始 1；
 *  - 视频：不参与图片平移逻辑，由上层传入 video 节点渲染，锚定尺寸约束；
 *  - 切素材重置 scale/offset/模式；pointer capture 在结束/取消/卸载时释放；
 *  - 原生 wheel 必须 passive:false（React onWheel 拦不住默认行为）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";

export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 8;
const DOUBLE_CLICK_ZOOM = 2;

export type ViewState = {
  scale: number;
  offsetX: number;
  offsetY: number;
  mode: "idle" | "panning" | "temporaryZoom";
};

export const INITIAL_VIEW: ViewState = { scale: 1, offsetX: 0, offsetY: 0, mode: "idle" };

interface MediaViewportProps {
  /** 素材 id：切换时重置视图（代际保护的一环） */
  assetId: number;
  /** 是否为视频：视频由 video 节点渲染，不挂图片平移交互 */
  isVideo: boolean;
  /** 图片高清源（URL）；null 时显示占位；视频路径可省略 */
  imageSrc?: string | null;
  /** 原文件兜底 URL（缩略图失效时） */
  imageFallbackUrl?: string;
  fileName: string;
  /** 视频节点（VideoPlayer）；此时 isVideo 必须为 true */
  video?: React.ReactNode;
  /** 图片 onError：上层可据此兜底到原文件 */
  onImageError?: () => void;
}

/** 舞台约束（指导书 §4.5）：视频媒体区最大宽 92%、最大高 82%；图片同规格 contain。 */
export const STAGE_WIDTH_PCT = 92;
export const STAGE_HEIGHT_PCT = 82;

export default function MediaViewport({
  assetId,
  isVideo,
  imageSrc,
  imageFallbackUrl,
  fileName,
  video,
  onImageError,
}: MediaViewportProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ViewState>(INITIAL_VIEW);
  /** 拖拽起点（元素坐标 + 起点偏移） */
  const dragStart = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);
  /** 记录按下的 pointerId：卸载时释放 capture */
  const activePointer = useRef<number | null>(null);
  /** 双击判定：上次 pointerdown 时间 */
  const lastDown = useRef(0);

  // 切素材：重置视图 + 清拖拽状态（代际保护起点）
  useEffect(() => {
    setView(INITIAL_VIEW);
    dragStart.current = null;
    activePointer.current = null;
  }, [assetId]);

  // 卸载时释放 pointer capture（§4.2）
  useEffect(() => {
    const el = stageRef.current;
    return () => {
      if (el && activePointer.current != null) {
        try {
          el.releasePointerCapture(activePointer.current);
        } catch {
          /* 已释放/无效 id 忽略 */
        }
      }
    };
  }, []);

  // Alt+滚轮以指针为锚点缩放；原生 passive:false（React onWheel 拦不住默认行为）
  const zoomAt = useCallback((clientX: number, clientY: number, nextRaw: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const next = Math.max(ZOOM_MIN, Math.min(nextRaw, ZOOM_MAX));
    const cx = clientX - (rect.left + rect.width / 2);
    const cy = clientY - (rect.top + rect.height / 2);
    setView((v) => {
      const imgX = (cx - v.offsetX) / v.scale;
      const imgY = (cy - v.offsetY) / v.scale;
      return { ...v, scale: next, offsetX: cx - imgX * next, offsetY: cy - imgY * next };
    });
  }, []);

  useEffect(() => {
    const el = stageRef.current;
    if (!el || isVideo) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.altKey) return;
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, view.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [view.scale, isVideo, zoomAt]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (isVideo) return;
    // 左键：未放大时只做双击判定；放大后拖拽平移
    if (e.button === 0) {
      const now = Date.now();
      const isDbl = now - lastDown.current < 350 && e.detail === 2;
      lastDown.current = now;
      if (isDbl) {
        // 双击切换：1x ↔ 2x（锚点为指针位置）；不再实现「按住才生效」隐藏语义
        if (view.scale === 1) {
          zoomAt(e.clientX, e.clientY, DOUBLE_CLICK_ZOOM);
        } else {
          setView(INITIAL_VIEW);
        }
        return;
      }
      if (view.scale <= 1) return; // 未放大不拖拽
    } else if (e.button !== 1) {
      return; // 中键兼容平移；其他按键忽略
    }
    e.preventDefault();
    activePointer.current = e.pointerId; // 先记录：capture 不可用（如 jsdom）时 pointerUp 仍能结算
    const el = e.currentTarget as HTMLElement;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* 某些环境 capture 不可用，退化为无 capture 拖拽 */
    }
    dragStart.current = { x: e.clientX, y: e.clientY, offsetX: view.offsetX, offsetY: view.offsetY };
    setView((v) => ({ ...v, mode: "panning" }));
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragStart.current) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setView((v) => ({
      ...v,
      offsetX: dragStart.current!.offsetX + dx,
      offsetY: dragStart.current!.offsetY + dy,
    }));
  };

  const endPan = (e: React.PointerEvent) => {
    if (e.pointerId !== activePointer.current) return;
    activePointer.current = null;
    dragStart.current = null;
    setView((v) => ({ ...v, mode: "idle" }));
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
  };

  const showSrc = imageSrc ?? imageFallbackUrl ?? null;
  const cursor = view.scale > 1 && !isVideo ? (view.mode === "panning" ? "grabbing" : "grab") : undefined;

  // 视频：不挂图片平移交互；内部事件由 VideoPlayer 自行 stopPropagation
  if (isVideo) {
    return (
      <div
        ref={stageRef}
        data-media-stage
        className={clsx(
          "relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden bg-[var(--color-bg)]",
        )}
        data-testid="media-viewport"
      >
        {/* 舞台约束：宽 92% / 高 82%，object-contain 不拉伸 */}
        <div className="flex max-h-[82%] max-w-[92%] items-center justify-center" style={{ maxHeight: `${STAGE_HEIGHT_PCT}%`, maxWidth: `${STAGE_WIDTH_PCT}%` }}>
          {video}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={stageRef}
      data-media-stage
      className={clsx(
        "relative flex min-h-0 min-w-0 flex-1 select-none items-center justify-center overflow-hidden bg-[var(--color-bg)]",
        cursor && "cursor-grab active:cursor-grabbing",
      )}
      style={cursor ? { cursor } : undefined}
      data-testid="media-viewport"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onContextMenu={(e) => e.preventDefault()}
    >
      {showSrc ? (
        <img
          key={assetId}
          src={showSrc}
          alt={fileName}
          draggable={false}
          onError={() => {
            // B27：缩略图失效时可回退到原文件（由上层兜底）
            if (imageSrc && imageFallbackUrl && imageSrc !== imageFallbackUrl) onImageError?.();
          }}
          className="max-h-full max-w-full object-contain select-none"
          style={{
            transform: `translate(${view.offsetX}px, ${view.offsetY}px) scale(${view.scale})`,
            transition: view.mode === "panning" ? "none" : "transform 120ms ease-out",
          }}
        />
      ) : (
        <div className="h-32 w-32 animate-pulse rounded bg-[var(--color-border)]" />
      )}
      {view.scale !== 1 && !isVideo && (
        <span className="absolute top-2 right-3 rounded bg-black/50 px-2 py-0.5 text-xs text-white">
          {Math.round(view.scale * 100)}%
        </span>
      )}
    </div>
  );
}