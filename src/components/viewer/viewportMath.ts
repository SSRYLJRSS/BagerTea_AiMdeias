/**
 * Viewer 坐标契约（指导书 §7.2）：唯一的指针→舞台坐标换算函数。
 * - 只使用 clientX/clientY 与舞台 getBoundingClientRect()；
 * - 禁止读取 SyntheticEvent/target 的 offsetX/offsetY；
 * - ref 缺失、宽高为 0、坐标非 finite 时安全返回（不抛异常）。
 */

export type StageRect = Pick<DOMRect, "left" | "top" | "width" | "height">;

export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 8;

/** 缩放钳制：非 finite 输入回退 1x（§7.2 安全返回） */
export function clampScale(next: number): number {
  if (!Number.isFinite(next)) return 1;
  return Math.max(ZOOM_MIN, Math.min(next, ZOOM_MAX));
}

/**
 * 把视口坐标换算为以舞台中心为原点的坐标。
 * 任一前提不满足（rect 缺失、宽高非正、client 坐标非有限）都安全返回中心 (0,0)。
 */
export function pointerInStage(
  clientX: number,
  clientY: number,
  rect: StageRect | null | undefined,
): { x: number; y: number } {
  if (!rect) return { x: 0, y: 0 };
  const { left, top, width, height } = rect;
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return { x: 0, y: 0 };
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return { x: 0, y: 0 };
  return {
    x: clientX - (left + width / 2),
    y: clientY - (top + height / 2),
  };
}

/** 沉浸模式平移时图像边缘最少保留在画布内的像素（§3.2：防止整张图丢到屏幕外无法找回） */
export const IMMERSIVE_EDGE_MARGIN = 48;

/**
 * 沉浸模式的平移约束：把 offset 钳制在「图像至少保留 margin 像素在画布内」的范围内。
 * 纯函数，不触碰 DOM。任一尺寸未知/非正/非有限时原样返回（jsdom 或图片加载前安全兜底）。
 *
 * 推导（图像以画布中心为原点 + offset 平移，缩放后半宽 half = imgW*scale/2）：
 *   - 图像右缘 = center + offset + half ≥ margin  → offset ≥ margin - half；
 *   - 图像左缘 = center + offset - half ≤ canvas - margin → offset ≤ canvas/2 + half - margin。
 * 高轴同理。
 */
export function clampImmersiveOffset(
  offsetX: number,
  offsetY: number,
  scale: number,
  imgW: number,
  imgH: number,
  canvasW: number,
  canvasH: number,
  margin: number = IMMERSIVE_EDGE_MARGIN,
): { x: number; y: number } {
  if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY)) return { x: offsetX, y: offsetY };
  if (!Number.isFinite(scale) || scale <= 0) return { x: offsetX, y: offsetY };
  if (
    !Number.isFinite(imgW) ||
    !Number.isFinite(imgH) ||
    imgW <= 0 ||
    imgH <= 0 ||
    !Number.isFinite(canvasW) ||
    !Number.isFinite(canvasH) ||
    canvasW <= 0 ||
    canvasH <= 0
  ) {
    return { x: offsetX, y: offsetY };
  }
  const halfW = (imgW * scale) / 2;
  const halfH = (imgH * scale) / 2;
  return {
    x: Math.max(margin - halfW, Math.min(canvasW / 2 + halfW - margin, offsetX)),
    y: Math.max(margin - halfH, Math.min(canvasH / 2 + halfH - margin, offsetY)),
  };
}