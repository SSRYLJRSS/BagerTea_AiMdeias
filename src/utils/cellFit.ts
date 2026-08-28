/**
 * FB2-02 智能填充判定（§9.4）：
 * cover = 裁切填满；contain = 完整显示；smart = 两者按内容比例与容器比例的相对差折中。
 */
import type { CellAspect, CellFit } from "@/types/settings";

/** smart 判定阈值：内容比例与容器比例的相对差小于此值时裁掉边缘可忽略 → cover */
export const SMART_FIT_TOLERANCE = 0.15;

/** 比例档位 → CSS aspect-ratio 值（如 "16 / 9"）。 */
export const ASPECT_CSS: Record<CellAspect, string> = {
  "1:1": "1 / 1",
  "4:3": "4 / 3",
  "3:2": "3 / 2",
  "16:9": "16 / 9",
  "3:4": "3 / 4",
  "2:3": "2 / 3",
  "9:16": "9 / 16",
};

/** 比例档位 → [w, h]，用于等高虚拟网格的行高计算。 */
export const ASPECT_RATIO: Record<CellAspect, [number, number]> = {
  "1:1": [1, 1],
  "4:3": [4, 3],
  "3:2": [3, 2],
  "16:9": [16, 9],
  "3:4": [3, 4],
  "2:3": [2, 3],
  "9:16": [9, 16],
};

/**
 * 把填充方式解析为最终二态。
 * @param contentAspect 内容宽/高比；未知（尺寸列为空/非法）时返回 cover（现状行为，避免回归）
 */
export function resolveFit(
  mode: CellFit,
  contentAspect: number | null | undefined,
  containerAspect: number,
): "cover" | "contain" {
  // 运行期兜底：非 cover/contain/smart 的非法值一律视为 cover（视觉安全默认）
  if (mode !== "cover" && mode !== "contain" && mode !== "smart") return "cover";
  if (mode !== "smart") return mode;
  if (contentAspect == null || !Number.isFinite(contentAspect) || contentAspect <= 0) return "cover";
  const diff = Math.abs(contentAspect - containerAspect) / containerAspect;
  return diff < SMART_FIT_TOLERANCE ? "cover" : "contain";
}