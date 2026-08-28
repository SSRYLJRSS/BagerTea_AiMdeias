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