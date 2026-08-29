/**
 * FB3-01（§3.2）：色板分段运行时归一化。
 * 后端 palette 数据在异常情况下可能产生非有限 ratio（NaN/Infinity）、越界值或非法 hex，
 * 混排渲染会造成 `NaN%` 段宽和累计布局误差。本模块是色板进 UI 前的唯一净化点：
 *  - ratio 过滤非有限值、截断到 [0,1]；
 *  - 总和为 0 时回退等宽（每段 1/n）；
 *  - 非法 hex（空/不以 # 开头）使用安全背景色。
 * 纯函数，与 ColorStrip 的渲染模式解耦，可独立单测。
 */
import type { PaletteSegment } from "@/components/library/ColorStrip";

/** 非法 hex 的兜底背景（中性深灰，不会与其他 UI 色冲突） */
export const SAFE_HEX = "#2e2e2e";

export function isSafeHex(hex: string): boolean {
  return typeof hex === "string" && /^#[0-9a-fA-F]{3,8}$/.test(hex);
}

/** 归一化 ratio：非有限/负数 → 0；>1 → 1 */
function normalizeRatio(r: number): number {
  if (!Number.isFinite(r) || r < 0) return 0;
  return Math.min(1, r);
}

/** 对分段数组做运行时归一化，返回新的安全分段（原数组不动）。 */
export function normalizeSegments(segments: PaletteSegment[]): PaletteSegment[] {
  const safe = segments.map((s) => ({
    ...s,
    ratio: normalizeRatio(s.ratio),
    hex: isSafeHex(s.hex) ? s.hex : SAFE_HEX,
  }));
  const total = safe.reduce((a, s) => a + s.ratio, 0);
  if (total <= 0) {
    // 总和为 0：等宽回退（空数组安全返回自身）
    const n = safe.length;
    return safe.map((s) => ({ ...s, ratio: n > 0 ? 1 / n : 0 }));
  }
  return safe;
}

/**
 * 归一化后的段宽（百分比数值 0–100）。mode=ratio 按占比、equal 等宽；
 * 输入已经过 normalizeSegments 的前提下不会产生 NaN。
 */
export function segmentWidth(
  segments: PaletteSegment[],
  index: number,
  mode: "ratio" | "equal",
): number {
  if (segments.length === 0) return 0;
  if (mode === "equal") return 100 / segments.length;
  const total = segments.reduce((a, s) => a + Math.max(0, normalizeRatio(s.ratio)), 0);
  if (total <= 0) return 100 / segments.length;
  return (Math.max(0, normalizeRatio(segments[index]?.ratio ?? 0)) / total) * 100;
}
