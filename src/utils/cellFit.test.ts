/** FB2-02 智能填充判定测试（§9.6） */
import { describe, expect, it } from "vitest";
import { resolveFit, ASPECT_RATIO, ASPECT_CSS } from "@/utils/cellFit";

describe("resolveFit（FB2-02）", () => {
  it("cover 直返 cover", () => {
    expect(resolveFit("cover", 1, 1)).toBe("cover");
  });

  it("contain 直返 contain", () => {
    expect(resolveFit("contain", 2, 1)).toBe("contain");
  });

  it("smart：内容比例接近容器比例 → cover", () => {
    // 容器 1:1（1.0），内容是 0.95/1.0 附近 → 相对差 < 0.15 → cover
    expect(resolveFit("smart", 1.05, 1)).toBe("cover");
  });

  it("smart：内容比例悬殊 → contain", () => {
    // 容器 1:1，竖图内容 2.5 → 相对差大 → contain
    expect(resolveFit("smart", 2.5, 1)).toBe("contain");
  });

  it("smart：contentAspect 为 null → cover（尺寸未知回退现状）", () => {
    expect(resolveFit("smart", null, 1)).toBe("cover");
  });

  it("非法 mode → cover（视觉兜底）", () => {
    // 虽然 TS 层限制 CellFit，运行期仍兜底
    expect(resolveFit("stretch" as never, 2, 1)).toBe("cover");
  });
});

describe("ASPECT 映射完整性", () => {
  it("所有档位都有 CSS 值与数值", () => {
    for (const key of ["1:1", "4:3", "3:2", "16:9", "3:4", "2:3", "9:16"]) {
      expect(ASPECT_CSS[key as keyof typeof ASPECT_CSS]).toBeTruthy();
      const [w, h] = ASPECT_RATIO[key as keyof typeof ASPECT_RATIO];
      expect(w).toBeGreaterThan(0);
      expect(h).toBeGreaterThan(0);
    }
  });
});