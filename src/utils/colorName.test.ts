/**
 * FB2-08：colorNameZh 纯函数测试（§14.10 中文色名映射）。
 */
import { describe, expect, it } from "vitest";
import { colorNameZh } from "@/utils/colorName";

describe("colorNameZh", () => {
  it("低饱和度归灰阶，按亮度分黑/深灰/灰/浅灰/白", () => {
    expect(colorNameZh(200, 0, 10)).toBe("黑");
    expect(colorNameZh(200, 3, 50)).toBe("灰");
    expect(colorNameZh(200, 5, 95)).toBe("白");
  });

  it("12 个 hue 段，取各段内部采样点", () => {
    expect(colorNameZh(7, 80, 50)).toBe("红");
    expect(colorNameZh(30, 80, 50)).toBe("橙");
    expect(colorNameZh(55, 80, 50)).toBe("黄");
    expect(colorNameZh(80, 80, 50)).toBe("黄绿");
    expect(colorNameZh(120, 80, 50)).toBe("绿");
    expect(colorNameZh(170, 80, 50)).toBe("青绿");
    expect(colorNameZh(210, 80, 50)).toBe("青");
    expect(colorNameZh(240, 80, 50)).toBe("天蓝");
    expect(colorNameZh(285, 80, 50)).toBe("蓝");
    expect(colorNameZh(305, 80, 50)).toBe("紫");
    expect(colorNameZh(330, 80, 50)).toBe("品红");
    expect(colorNameZh(350, 80, 50)).toBe("玫红");
  });

  it("hue 环绕：负值归一", () => {
    expect(colorNameZh(-5, 80, 50)).toBe("玫红"); // -5%360=355 → 玫红
  });

  it("深/浅前缀：lum<25 → 深，>75 → 浅", () => {
    expect(colorNameZh(210, 80, 20)).toBe("深青");
    expect(colorNameZh(210, 80, 80)).toBe("浅青");
  });

  it("分段边界一致性：每段中点色名与 super_search_ai.rs prompt 的色相分段吻合（FX-19）", () => {
    // 该测试锁住 HUE_NAMES 分段：改了 colorName.ts 分段而不同步 AI prompt 时，
    // 此处人工同步的期望值会红，提醒跨语言两处一起改。
    const cases: [number, string][] = [
      [8, "红"], // 0-15
      [30, "橙"], // 15-45
      [58, "黄"], // 45-70（prompt：黄 45-70）
      [80, "黄绿"], // 70-90
      [120, "绿"], // 90-155（prompt：绿 70-155）
      [170, "青绿"], // 155-185
      [205, "青"], // 185-225（prompt：青 155-225）
      [235, "天蓝"], // 225-255
      [275, "蓝"], // 255-295（prompt：蓝 225-295）
      [308, "紫"], // 295-320（prompt：紫 295-345）
      [330, "品红"], // 320-345
      [350, "玫红"], // 345-360
    ];
    for (const [hue, name] of cases) {
      expect(colorNameZh(hue, 80, 50)).toBe(name);
    }
  });
});