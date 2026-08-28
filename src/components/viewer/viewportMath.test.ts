/**
 * viewportMath 坐标契约测试（指导书 §7.2 / §7.6）：
 * - 正常 rect 换算：以舞台中心为原点；
 * - rect 缺失、宽高为 0、坐标非 finite 时安全返回中心 (0,0)，不抛异常；
 * - clampScale：0.2~8 边界、非 finite 输入回退 1。
 */
import { describe, expect, it } from "vitest";
import { clampScale, pointerInStage, ZOOM_MAX, ZOOM_MIN } from "@/components/viewer/viewportMath";

describe("pointerInStage（§7.2 坐标契约）", () => {
  it("正常 rect：以舞台中心为原点", () => {
    // 舞台 left=100 top=80 width=200 height=100 → 中心 (200, 130)
    expect(pointerInStage(200, 130, { left: 100, top: 80, width: 200, height: 100 })).toEqual({ x: 0, y: 0 });
    expect(pointerInStage(250, 150, { left: 100, top: 80, width: 200, height: 100 })).toEqual({ x: 50, y: 20 });
    expect(pointerInStage(150, 80, { left: 100, top: 80, width: 200, height: 100 })).toEqual({ x: -50, y: -50 });
  });

  it("rect 缺失时安全返回中心 (0,0)，不抛异常", () => {
    expect(pointerInStage(100, 100, null)).toEqual({ x: 0, y: 0 });
    expect(pointerInStage(100, 100, undefined)).toEqual({ x: 0, y: 0 });
  });

  it("宽高为 0（jsdom/未布局）时安全返回中心 (0,0)", () => {
    expect(pointerInStage(100, 100, { left: 0, top: 0, width: 0, height: 0 })).toEqual({ x: 0, y: 0 });
    expect(pointerInStage(100, 100, { left: 0, top: 0, width: 200, height: 0 })).toEqual({ x: 0, y: 0 });
  });

  it("坐标非 finite 时安全返回中心 (0,0)", () => {
    expect(pointerInStage(Number.NaN, 100, { left: 0, top: 0, width: 200, height: 100 })).toEqual({ x: 0, y: 0 });
    expect(pointerInStage(100, Number.NaN, { left: 0, top: 0, width: 200, height: 100 })).toEqual({ x: 0, y: 0 });
    expect(pointerInStage(Number.POSITIVE_INFINITY, 100, { left: 0, top: 0, width: 200, height: 100 })).toEqual({
      x: 0,
      y: 0,
    });
  });
});

describe("clampScale（§7.4 缩放范围 0.2~8）", () => {
  it("正常值钳制在 [0.2, 8]", () => {
    expect(clampScale(1)).toBe(1);
    expect(clampScale(ZOOM_MIN)).toBe(ZOOM_MIN);
    expect(clampScale(ZOOM_MAX)).toBe(ZOOM_MAX);
    expect(clampScale(0.05)).toBe(ZOOM_MIN);
    expect(clampScale(100)).toBe(ZOOM_MAX);
  });

  it("非 finite 输入回退 1x", () => {
    expect(clampScale(Number.NaN)).toBe(1);
    expect(clampScale(Number.POSITIVE_INFINITY)).toBe(1);
  });
});