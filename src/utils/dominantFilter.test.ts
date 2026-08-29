/** FB2-08（§17.2）：dominantFiltersFor 纯函数单测 —— 色相窗口/跨 0° 环形表达/低饱和灰阶分支/钳制 */
import { describe, expect, it } from "vitest";
import { dominantFiltersFor } from "@/utils/dominantFilter";

describe("dominantFiltersFor", () => {
  it("常规色相：hue ±15 + sat ±25（上界钳到 100）", () => {
    const f = dominantFiltersFor({ hue: 210, sat: 80 });
    expect(f).toHaveLength(2);
    expect(f[0]).toEqual({ key: "dominant_hue", op: "between", min: 195, max: 225 });
    expect(f[1]).toEqual({ key: "dominant_sat", op: "between", min: 55, max: 100 });
  });

  it("跨 0°：hue=5 → between 350~20（min > max 交给后端双区间 OR）", () => {
    const f = dominantFiltersFor({ hue: 5, sat: 80 });
    expect(f[0]).toEqual({ key: "dominant_hue", op: "between", min: 350, max: 20 });
  });

  it("跨 0°：hue=355 → between 340~10", () => {
    const f = dominantFiltersFor({ hue: 355, sat: 80 });
    expect(f[0]).toEqual({ key: "dominant_hue", op: "between", min: 340, max: 10 });
  });

  it("低饱和灰阶：只按 dominant_sat lte 10 筛，不含 hue 条件", () => {
    const f = dominantFiltersFor({ hue: 60, sat: 3 });
    expect(f).toEqual([{ key: "dominant_sat", op: "lte", value: 10 }]);
  });

  it("sat 下界钳到 0", () => {
    const f = dominantFiltersFor({ hue: 210, sat: 20 });
    expect(f[1]).toEqual({ key: "dominant_sat", op: "between", min: 0, max: 45 });
  });
});
