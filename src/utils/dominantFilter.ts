/**
 * FB2-08（§14.9）：由色条主色段构造"同色系"检索条件（纯函数，配单测）。
 *  - hue ±15° 是色相环上"同色系"的经验窗口（12 段色名映射每段约 30°，取半段）。
 *    跨 0° 时故意让 min > max —— 后端 compile_number 对 dominant_hue 的 min>max
 *    编译成双区间 OR（search_query.rs），这是环形量的正确表达，不是参数错误。
 *  - sat 窗口宽得多（±25）：同色系允许饱和度差异，卡太紧会漏掉大量素材。
 *  - lum 不加约束 —— 深蓝与浅蓝都是"蓝色系"。
 */
import type { MetadataFilter } from "@/types/asset";

const HUE_WINDOW = 15;
const SAT_WINDOW = 25;

export function dominantFiltersFor(seg: { hue: number; sat: number }): MetadataFilter[] {
  const lo = (((seg.hue - HUE_WINDOW) % 360) + 360) % 360;
  const hi = (seg.hue + HUE_WINDOW) % 360;
  const filters: MetadataFilter[] = [
    { key: "dominant_hue", op: "between", min: lo, max: hi },
  ];
  // 低饱和（灰阶）主色：hue 无意义，只按饱和度筛，否则会搜出一堆无关色相
  if (seg.sat < 10) {
    return [{ key: "dominant_sat", op: "lte", value: 10 }];
  }
  filters.push({
    key: "dominant_sat",
    op: "between",
    min: Math.max(0, seg.sat - SAT_WINDOW),
    max: Math.min(100, seg.sat + SAT_WINDOW),
  });
  return filters;
}
