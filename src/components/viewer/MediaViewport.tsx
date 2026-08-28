/**
 * MediaViewport（指导书 §4.2 / §7）：查看器媒体舞台。
 *  - 图片：Pointer Events 平移/双击缩放/Alt+滚轮锚点缩放/左键缩放后拖拽/中键兼容平移；
 *  - ViewState 状态机 idle|panning|temporaryZoom（§7.4：idle -> panning -> idle；idle -> temporaryZoom -> idle）；
 *    缩放钳制 0.2–8，初始 1；恢复 1x 时 offset 归零；
 *  - 坐标契约（§7.2）：唯一坐标函数 pointerInStage（viewportMath.ts），只使用 clientX/clientY
 *    + stageRef.getBoundingClientRect()；禁止读取 SyntheticEvent/target 的 offsetX/offsetY；
 *  - 代际保护（§7.3）：assetId/图片源变化递增 generation；原生 wheel listener、图片 onError、
 *    拖拽回调捕获代际，执行前不一致则丢弃（快速切图后旧回调不改新素材）；
 *  - pointer capture 在 pointerup/pointercancel/卸载时释放；dragStart 为空时 pointermove 直接返回；
 *  - 视频：不参与图片平移逻辑，由上层传入 video 节点渲染，锚定尺寸约束；
 *  - 致命错误（§7.5）：沿用现有边界视觉显示「当前素材暂时无法显示」，重新加载需由上层重新获取 URL/高清图。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import StageFrame from "@/components/viewer/StageFrame";
import { pointerInStage, clampScale, ZOOM_MIN, ZOOM_MAX } from "@/components/viewer/viewportMath";

export { ZOOM_MIN, ZOOM_MAX };

const DOUBLE_CLICK_ZOOM = 2;

export type ViewState = {
  scale: number;
  offsetX: number;
  offsetY: number;
  mode: "idle" | "panning" | "temporaryZoom";
};

export const INITIAL_VIEW: ViewState = { scale: 1, offsetX: 0, offsetY: 0, mode: "idle" };

/** temporaryZoom 自动回落 idle 的延时（匹配 transform 120ms 过渡完成后再回落） */
const TEMP_ZOOM_REVERT_MS = 160;

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
  /** 图片 onError：高清图失败可回落原文件（由上层兜底） */
  onImageError?: () => void;
  /** 致命错误：主图与兜底都失败时由上层置位；显示 §7.5 错误视觉 */
  fatal?: boolean;
  /** §7.5 重新加载当前素材：必须重新获取 URL/高清图并重置 Viewer 状态 */
  onRetryCurrent?: () => void;
  /** §7.5 返回素材库 */
  onBackToLibrary?: () => void;
}

export default function MediaViewport({
  assetId,
  isVideo,
  imageSrc,
  imageFallbackUrl,
  fileName,
  video,
  onImageError,
  fatal = false,
  onRetryCurrent,
  onBackToLibrary,
}: MediaViewportProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ViewState>(INITIAL_VIEW);
  /** 拖拽起点（元素坐标 + 起点偏移） */
  const dragStart = useRef<{ x: number; y: number; offsetX: number; offsetY: number; gen: number } | null>(null);
  /** 记录按下的 pointerId：卸载时释放 capture */
  const activePointer = useRef<number | null>(null);
  /** 双击判定：上次 pointerdown 时间 */
  const lastDown = useRef(0);
  /** temporaryZoom 回落 idle 的定时器 */
  const zoomTimer = useRef<number | null>(null);
  /** 代际保护（§7.3）：assetId/图片源变化、重试、卸载时递增 */
  const generation = useRef(0);
  /** 首挂载不递增：首个 onError 闭包捕获的代际必须与挂载时一致（否则第一次错误就被丢弃） */
  const firstRender = useRef(true);

  // 切素材/换源：代际 +1，重置视图 + 清拖拽状态（§7.3）
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return; // 首挂载：视图已是 INITIAL_VIEW 且无需递增
    }
    generation.current += 1;
    setView(INITIAL_VIEW);
    dragStart.current = null;
    activePointer.current = null;
    if (zoomTimer.current != null) {
      window.clearTimeout(zoomTimer.current);
      zoomTimer.current = null;
    }
  }, [assetId, imageSrc]);

  // 卸载时清理：释放 pointer capture、清 temporaryZoom 定时器、代际 +1 使旧回调失效
  useEffect(() => {
    const el = stageRef.current;
    return () => {
      generation.current += 1;
      if (zoomTimer.current != null) {
        window.clearTimeout(zoomTimer.current);
        zoomTimer.current = null;
      }
      if (el && activePointer.current != null) {
        try {
          el.releasePointerCapture(activePointer.current);
        } catch {
          /* 已释放/无效 id 忽略 */
        }
      }
    };
  }, []);

  /** 统一缩放 reducer（§7.2 双击、wheel、触摸缩放都走这里）：
   *  以指针为锚点；next 回到 1x 时 offset 归零；返回 clamped scale。 */
  const zoomAt = useCallback((clientX: number, clientY: number, nextRaw: number, gen: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    const { x, y } = pointerInStage(clientX, clientY, rect);
    const next = clampScale(nextRaw);
    setView((v) => {
      if (gen !== generation.current) return v; // 旧代际丢弃（§7.3）
      if (next === 1) return INITIAL_VIEW; // 恢复 1x：offset 归零（§7.4）
      const imgX = (x - v.offsetX) / v.scale;
      const imgY = (y - v.offsetY) / v.scale;
      return { ...v, scale: next, offsetX: x - imgX * next, offsetY: y - imgY * next, mode: "temporaryZoom" };
    });
  }, []);

  /** temporaryZoom 短暂停留后回落 idle（§7.4 idle -> temporaryZoom -> idle） */
  const armTemporaryZoomRevert = useCallback(() => {
    if (zoomTimer.current != null) window.clearTimeout(zoomTimer.current);
    zoomTimer.current = window.setTimeout(() => {
      zoomTimer.current = null;
      setView((v) => (v.mode === "temporaryZoom" ? { ...v, mode: "idle" } : v));
    }, TEMP_ZOOM_REVERT_MS);
  }, []);

  // Alt+滚轮以指针为锚点缩放；原生 passive:false（React onWheel 拦不住默认行为）
  useEffect(() => {
    const el = stageRef.current;
    if (!el || isVideo) return;
    const gen = generation.current; // 订阅时捕获代际（§7.3）
    const onWheel = (e: WheelEvent) => {
      if (gen !== generation.current) return; // 旧代际丢弃
      if (!e.altKey) return;
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, view.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15), gen);
      armTemporaryZoomRevert();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [view.scale, isVideo, zoomAt, armTemporaryZoomRevert, assetId]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (isVideo) return;
    const gen = generation.current; // 按下时捕获代际（§7.3）
    // 左键：未放大时只做双击判定；放大后拖拽平移
    if (e.button === 0) {
      const now = Date.now();
      const isDbl = now - lastDown.current < 350 && e.detail === 2;
      lastDown.current = now;
      if (isDbl) {
        // 双击切换：1x ↔ 2x（锚点为指针位置）；不再实现「按住才生效」隐藏语义
        if (view.scale === 1) {
          zoomAt(e.clientX, e.clientY, DOUBLE_CLICK_ZOOM, gen);
          armTemporaryZoomRevert();
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
    dragStart.current = { x: e.clientX, y: e.clientY, offsetX: view.offsetX, offsetY: view.offsetY, gen };
    setView((v) => ({ ...v, mode: "panning" }));
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const start = dragStart.current;
    if (!start) return; // dragStart 为空直接返回（§7.4）
    if (start.gen !== generation.current) return; // 旧代际丢弃
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    setView((v) => ({
      ...v,
      offsetX: start.offsetX + dx,
      offsetY: start.offsetY + dy,
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
  // 图片 onError 捕获当前代际（§7.3）：切图后旧 img 的错误回调不得改写新素材
  const errorGen = generation.current;
  const cursor = view.scale > 1 && !isVideo ? (view.mode === "panning" ? "grabbing" : "grab") : undefined;

  /* §7.5 致命错误：主图与兜底都失败时的 Viewer 局部错误（沿用现有边界视觉，不新建第二套边界） */
  if (fatal && !isVideo) {
    return (
      <StageFrame className="flex-col gap-3 p-6 text-center">
        <p className="text-base font-medium text-[var(--color-text)]">当前素材暂时无法显示</p>
        <p className="max-w-md text-sm text-[var(--color-text-secondary)]">
          可能是文件损坏、路径不可用或媒体解码失败。
        </p>
        <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            onClick={() => onRetryCurrent?.()}
            className="rounded-[var(--radius-control)] bg-[var(--color-accent)] px-3.5 py-2 text-sm font-medium text-[var(--color-accent-text)] hover:bg-[var(--color-accent-hover)]"
          >
            重新加载当前素材
          </button>
          <button
            type="button"
            onClick={() => onBackToLibrary?.()}
            className="rounded-[var(--radius-control)] border border-[var(--color-border)] px-3.5 py-2 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface)]"
          >
            返回素材库
          </button>
        </div>
      </StageFrame>
    );
  }

  // 视频：不挂图片平移交互；内部事件由 VideoPlayer 自行 stopPropagation。
  // 直接作为 StageFrame 子节点（VideoPlayer 自带 max-h-full max-w-full + object-contain）。
  if (isVideo) {
    return <StageFrame stageRef={stageRef}>{video}</StageFrame>;
  }

  return (
    <StageFrame
      stageRef={stageRef}
      className={clsx("select-none", cursor && "cursor-grab active:cursor-grabbing")}
      style={cursor ? { cursor } : undefined}
      handlers={{
        onPointerDown,
        onPointerMove,
        onPointerUp: endPan,
        onPointerCancel: endPan,
        onContextMenu: (e) => e.preventDefault(),
      }}
    >
      {showSrc ? (
        <img
          key={assetId}
          src={showSrc}
          alt={fileName}
          draggable={false}
          onError={() => {
            // 代际保护（§7.3）：旧代际的错误回调直接丢弃；一律上报 onImageError，
            // 由上层区分「高清图失败→回落原文件」与「兜底也失败→置 fatal」。
            if (errorGen !== generation.current) return;
            onImageError?.();
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
    </StageFrame>
  );
}