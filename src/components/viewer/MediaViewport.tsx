/**
 * MediaViewport（指导书 §4.2 / §7 + FB5-01 §4.3）：查看器媒体舞台。
 *  - 图片：Pointer Events 平移/双击缩放/Alt+滚轮锚点缩放/左键缩放后拖拽/中键兼容平移；
 *  - ViewState 状态机 idle|panning|temporaryZoom（§7.4：idle -> panning -> idle；idle -> temporaryZoom -> idle）；
 *    缩放钳制 0.2–8，初始 1；恢复 1x 时 offset 归零；
 *  - 坐标契约（§7.2）：唯一坐标函数 pointerInStage（viewportMath.ts），只使用 clientX/clientY
 *    + stageRef.getBoundingClientRect()；禁止读取 SyntheticEvent/target 的 offsetX/offsetY；
 *  - 代际保护（§7.3）：assetId/图片源/沉浸状态变化递增 generation；原生 wheel listener、图片 onError、
 *    拖拽回调捕获代际，执行前不一致则丢弃（快速切图后旧回调不改新素材）；
 *  - pointer capture 在 pointerup/pointercancel/卸载时释放；dragStart 为空时 pointermove 直接返回；
 *  - FB5-01（§4.3）：immersive 沉浸浏览 —— 图片白底（StageFrame surface），1x 也可左键平移
 *    （canLeftPan = immersive || view.scale > 1），平移 offset 经 clampImmersiveOffset 约束
 *    （至少保留 48px 图像边缘在画布内）；进入/退出沉浸或切 assetId 时重置居中适应状态；
 *    双击在 1x/2x 间切换；视频双击调用 onToggleImmersive；
 *  - 视频：不参与图片平移逻辑，由上层传入 video 节点渲染，锚定尺寸约束；
 *  - 致命错误（§7.5）：沿用现有边界视觉显示「当前素材暂时无法显示」，重新加载需由上层重新获取 URL/高清图。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { RotateCw } from "lucide-react";
import StageFrame, { type StageSurface } from "@/components/viewer/StageFrame";
import { pointerInStage, clampScale, clampImmersiveOffset, ZOOM_MIN, ZOOM_MAX } from "@/components/viewer/viewportMath";

export { ZOOM_MIN, ZOOM_MAX };

const DOUBLE_CLICK_ZOOM = 2;

/** temporaryZoom 自动回落 idle 的延时（匹配 transform 120ms 过渡完成后再回落） */
const TEMP_ZOOM_REVERT_MS = 160;

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
  /** FB5-01（§4.3）：沉浸浏览。图片 1x 可平移 + 白底；视频双击可切换沉浸 */
  immersive?: boolean;
  /** FB5-01（§4.3）：视频双击切换沉浸模式（由 ViewerPage 统一状态机驱动） */
  onToggleImmersive?: () => void;
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
  immersive = false,
  onToggleImmersive,
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
  const imgRef = useRef<HTMLImageElement>(null);
  const [view, setView] = useState<ViewState>(INITIAL_VIEW);
  /** 拖拽起点（元素坐标 + 起点偏移） */
  const dragStart = useRef<{ x: number; y: number; offsetX: number; offsetY: number; gen: number } | null>(null);
  /** 记录按下的 pointerId：卸载时释放 capture */
  const activePointer = useRef<number | null>(null);
  /** temporaryZoom 回落 idle 的定时器 */
  const zoomTimer = useRef<number | null>(null);
  /** 代际保护（§7.3）：assetId/图片源/沉浸状态变化、重试、卸载时递增 */
  const generation = useRef(0);
  /** 首挂载不递增：首个 onError 闭包捕获的代际必须与挂载时一致（否则第一次错误就被丢弃） */
  const firstRender = useRef(true);
  /** FB6 需求六：查看器临时旋转角（只影响视觉，不写回文件/数据库；累加不取模） */
  const [viewerRotation, setViewerRotation] = useState(0);
  /** 旋转按钮可见性：仅当指针碰到底部居中的旋钮热区（或键盘聚焦按钮）才浮现 */
  const [rotateVisible, setRotateVisible] = useState(false);

  const showRotateControls = useCallback(() => setRotateVisible(true), []);
  /** 指针离开旋钮热区/舞台：立即隐藏，不让按钮残留 */
  const hideRotateControls = useCallback(() => setRotateVisible(false), []);

  // FB6 需求六：顺时针旋转 90°——回到当前缩放比例的居中状态（offset 归零），避免图片被转出舞台。
  // 角度累加不取模：第 4 次点击继续滚到 360°（CSS 过渡始终顺时针 +90°），
  // 若 %360 会在 270°→0° 时倒转 270°，视觉上像倒带。切图时统一归零。
  const rotateClockwise = useCallback(() => {
    setViewerRotation((r) => r + 90);
    setView((v) => (v.offsetX !== 0 || v.offsetY !== 0 ? { ...v, offsetX: 0, offsetY: 0 } : v));
    showRotateControls();
  }, [showRotateControls]);

  // 切素材/换源/切沉浸：代际 +1，重置视图 + 清拖拽状态（§7.3 + FB5-01：进入/退出沉浸重置居中）
  // FB6 需求六：同时隐藏旋转按钮并归零临时旋转（切图不继承上一张的旋转角）
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return; // 首挂载：视图已是 INITIAL_VIEW 且无需递增
    }
    generation.current += 1;
    setView(INITIAL_VIEW);
    setViewerRotation(0);
    setRotateVisible(false);
    dragStart.current = null;
    activePointer.current = null;
    if (zoomTimer.current != null) {
      window.clearTimeout(zoomTimer.current);
      zoomTimer.current = null;
    }
  }, [assetId, imageSrc, immersive]);

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
          /* 忽略 */
        }
      }
      activePointer.current = null;
    };
  }, []);

  /** 锚点缩放 reducer：temporaryZoom 状态（§7.4） */
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

  // FB3-05（§7.3）：双击用原生 onDoubleClick（不手工依赖 pointerdown 的 e.detail/时间窗口——
  // WebView2/触摸板/子节点截获时该判定脆弱）；统一走 zoomAt reducer。
  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (isVideo) return;
      const gen = generation.current;
      if (view.scale === 1) {
        zoomAt(e.clientX, e.clientY, DOUBLE_CLICK_ZOOM, gen);
        armTemporaryZoomRevert();
      } else {
        setView(INITIAL_VIEW); // 已放大：回 1x，offset 归零（适应屏幕并居中）
      }
    },
    [isVideo, view.scale, zoomAt, armTemporaryZoomRevert],
  );

  // FB5-01（§4.3）：沉浸模式 1x 也可左键平移；正常模式保持「未放大时左键不拖拽」。
  const canLeftPan = immersive || view.scale > 1;

  const onPointerDown = (e: React.PointerEvent) => {
    if (isVideo) return;
    const gen = generation.current; // 按下时捕获代际（§7.3）
    // 左键：未放大且非沉浸不拖拽（等待双击）；沉浸/放大后拖拽平移。中键兼容平移；其他按键忽略。
    if (e.button === 0) {
      if (!canLeftPan) return;
    } else if (e.button !== 1) {
      return;
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
    setView((v) => {
      let offsetX = start.offsetX + dx;
      let offsetY = start.offsetY + dy;
      // FB5-01（§4.3）：沉浸平移受 clampImmersiveOffset 约束（至少保留 48px 图像边缘）。
      // 正常模式缩放>1 的平移保持原有语义（用户可把放大图拖到边缘裁切浏览）。
      if (immersive) {
        const rect = stageRef.current?.getBoundingClientRect();
        const img = imgRef.current;
        if (rect && img) {
          const clamped = clampImmersiveOffset(
            offsetX,
            offsetY,
            v.scale,
            img.naturalWidth || img.width || 0,
            img.naturalHeight || img.height || 0,
            rect.width,
            rect.height,
          );
          offsetX = clamped.x;
          offsetY = clamped.y;
        }
      }
      return { ...v, offsetX, offsetY };
    });
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
  const cursor = canLeftPan && !isVideo ? (view.mode === "panning" ? "grabbing" : "grab") : undefined;
  const surface: StageSurface = isVideo ? (immersive ? "video-immersive" : "app") : immersive ? "image-immersive" : "app";

  /* §7.5 致命错误：主图与兜底都失败时的 Viewer 局部错误（沿用现有边界视觉，不新建第二套边界） */
  if (fatal && !isVideo) {
    return (
      <StageFrame className="flex-col gap-3 p-6 text-center" surface={surface}>
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
  // 直接作为 StageFrame 子节点（FB3-03：VideoPlayer 根节点 h-full flex-col，自带高度契约）。
  // FB5-01（§4.3）：视频双击切换沉浸模式。
  if (isVideo) {
    return (
      <StageFrame stageRef={stageRef} surface={surface}>
        <div
          className="h-full w-full"
          onDoubleClick={(e) => {
            e.stopPropagation();
            onToggleImmersive?.();
          }}
        >
          {video}
        </div>
      </StageFrame>
    );
  }

  return (
    <StageFrame
      stageRef={stageRef}
      surface={surface}
      className={clsx("select-none", cursor && "cursor-grab active:cursor-grabbing")}
      style={cursor ? { cursor } : undefined}
      handlers={{
        onPointerDown,
        onPointerMove,
        onPointerUp: endPan,
        onPointerCancel: endPan,
        onDoubleClick,
        // FB6 需求六：指针离开舞台兜底隐藏（主开关在旋钮热区上）
        onPointerLeave: () => hideRotateControls(),
        onContextMenu: (e) => e.preventDefault(),
      }}
    >
      {showSrc ? (
        <img
          key={assetId}
          ref={imgRef}
          src={showSrc}
          alt={fileName}
          draggable={false}
          onError={() => {
            // 代际保护（§7.3）：旧代际的错误回调直接丢弃；一律上报 onImageError，
            // 由上层区分「高清图失败→回落原文件」与「兜底也失败→置 fatal」。
            if (errorGen !== generation.current) return;
            onImageError?.();
          }}
          className="max-h-full max-w-full object-contain select-none motion-reduce:transition-none"
          style={{
            transform: `translate(${view.offsetX}px, ${view.offsetY}px) scale(${view.scale}) rotate(${viewerRotation}deg)`,
            transition: view.mode === "panning" ? "none" : "transform 120ms ease-out",
          }}
        />
      ) : (
        <div className="h-32 w-32 animate-pulse rounded bg-[var(--color-border)]" />
      )}
      {/* FB6 需求六：图片悬浮旋转按钮（仅图片模式；水平居中、贴舞台下沿 —— 位于图片底部、
          查看器色条上方）。平时完全隐藏，鼠标碰到底部居中的热区才浮现，移开即消失；
          键盘 Tab 聚焦按钮同样浮现（无障碍可达）。fatal 分支不渲染。 */}
      <div
        data-testid="rotate-hotzone"
        className="absolute bottom-0 left-1/2 z-10 -translate-x-1/2 p-3"
        onPointerEnter={() => showRotateControls()}
        onPointerLeave={() => hideRotateControls()}
      >
        <button
          type="button"
          aria-label="顺时针旋转"
          title="顺时针旋转"
          // 隐藏态：移出无障碍树与 Tab 序（浮现时恢复），避免「看不见却可聚焦」
          aria-hidden={rotateVisible ? undefined : true}
          tabIndex={rotateVisible ? 0 : -1}
          onClick={(e) => {
            e.stopPropagation();
            rotateClockwise();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onFocus={() => showRotateControls()}
          onBlur={() => hideRotateControls()}
          className={clsx(
            "flex size-9 items-center justify-center rounded-full bg-black/45 text-white shadow-sm transition-opacity duration-150 hover:bg-black/60 focus-visible:ring-1 focus-visible:ring-[var(--color-status)] focus-visible:outline-none motion-reduce:transition-none",
            rotateVisible ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          <RotateCw size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      {/* 缩放 badge：普通模式显示；沉浸模式不显示文件名/页码/缩放 badge（§3.2） */}
      {view.scale !== 1 && !isVideo && !immersive && (
        <span className="absolute top-2 right-3 rounded bg-black/50 px-2 py-0.5 text-xs text-white">
          {Math.round(view.scale * 100)}%
        </span>
      )}
    </StageFrame>
  );
}
