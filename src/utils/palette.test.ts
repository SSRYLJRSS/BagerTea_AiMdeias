/** FB3-01（§3.3）：palette 运行时归一化单测 —— 异常 ratio/hex 不产生 NaN 宽度 */
import { describe, expect, it } from "vitest";
import { normalizeSegments, segmentWidth, isSafeHex, SAFE_HEX } from "@/utils/palette";
import type { PaletteSegment } from "@/components/library/ColorStrip";

const seg = (over: Partial<PaletteSegment>): PaletteSegment => ({
  hex: "#123456",
  ratio: 0.5,
  hue: 210,
  sat: 50,
  lum: 40,
  ...over,
});

describe("normalizeSegments（FB3-01）", () => {
  it("过滤 NaN/负数 ratio（归 0），截断 >1 到 1", () => {
    const out = normalizeSegments([
      seg({ ratio: Number.NaN }),
      seg({ ratio: -0.3 }),
      seg({ ratio: 2 }),
      seg({ ratio: 0.5 }),
    ]);
    expect(out.map((s) => s.ratio)).toEqual([0, 0, 1, 0.5]);
  });

  it("非法 hex 替换为安全背景色；合法 hex 保留", () => {
    const out = normalizeSegments([seg({ hex: "not-a-color" }), seg({ hex: "#abc" })]);
    expect(out[0].hex).toBe(SAFE_HEX);
    expect(out[1].hex).toBe("#abc");
  });

  it("总和为 0 时回退等宽（1/n），不产生除零 NaN", () => {
    const out = normalizeSegments([seg({ ratio: 0 }), seg({ ratio: 0 }), seg({ ratio: 0 })]);
    expect(out.every((s) => s.ratio === 1 / 3)).toBe(true);
    expect(out.every((s) => Number.isFinite(s.ratio))).toBe(true);
  });

  it("空数组安全返回", () => {
    expect(normalizeSegments([])).toEqual([]);
  });
});

describe("segmentWidth（FB3-01）", () => {
  it("ratio 模式按占比；等比总和为 100", () => {
    const s = normalizeSegments([seg({ ratio: 0.75 }), seg({ ratio: 0.25 })]);
    const w0 = segmentWidth(s, 0, "ratio");
    const w1 = segmentWidth(s, 1, "ratio");
    expect(w0).toBeCloseTo(75);
    expect(w1).toBeCloseTo(25);
    expect(w0 + w1).toBeCloseTo(100);
  });

  it("equal 模式等宽；全 0 ratio 也不产生 NaN", () => {
    const s = normalizeSegments([seg({ ratio: 0 }), seg({ ratio: 0 }), seg({ ratio: 0 }), seg({ ratio: 0 })]);
    expect(segmentWidth(s, 0, "equal")).toBeCloseTo(25);
    expect(Number.isFinite(segmentWidth(s, 0, "ratio"))).toBe(true);
  });

  it("空数组返回 0（不抛异常）", () => {
    expect(segmentWidth([], 0, "ratio")).toBe(0);
  });
});

describe("isSafeHex", () => {
  it("接受 #RGB/#RRGGBB/#RRGGBBAA；拒绝无 #、空串、乱字符", () => {
    expect(isSafeHex("#abc")).toBe(true);
    expect(isSafeHex("#1b6ad2")).toBe(true);
    expect(isSafeHex("#1b6ad2ff")).toBe(true);
    expect(isSafeHex("1b6ad2")).toBe(false);
    expect(isSafeHex("")).toBe(false);
    expect(isSafeHex("#zzz")).toBe(false);
  });
});
