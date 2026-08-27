import { describe, expect, it } from "vitest";
import { computePopoverPosition } from "@/components/media/MediaPreviewPopover";

describe("computePopoverPosition（§7.3 边界避让）", () => {
  const viewport = { width: 1000, height: 800 };

  it("默认在触发器下方居中", () => {
    const p = computePopoverPosition({ left: 400, top: 200, width: 200, height: 40 }, { width: 420, height: 300 }, viewport);
    expect(p.left).toBeCloseTo(400 + 100 - 210); // 400+200/2 - 420/2 = 290
    expect(p.top).toBeCloseTo(200 + 40 + 8);
  });

  it("右侧越界时向左钳制", () => {
    const p = computePopoverPosition({ left: 900, top: 200, width: 100, height: 40 }, { width: 420, height: 300 }, viewport);
    // 居中 = 900+50-210=740；但 740+420 > 1000-8 → 钳制到 1000-420-8=572
    expect(p.left).toBeCloseTo(572);
  });

  it("左侧越界时向右钳制", () => {
    const p = computePopoverPosition({ left: 10, top: 200, width: 100, height: 40 }, { width: 420, height: 300 }, viewport);
    expect(p.left).toBeCloseTo(8); // margin
  });

  it("底部越界时放到触发器上方", () => {
    const p = computePopoverPosition({ left: 400, top: 700, width: 200, height: 40 }, { width: 420, height: 300 }, viewport);
    // 下方 700+40+8=748，748+300 > 800-8 → 放到上方 700-300-8=392
    expect(p.top).toBeCloseTo(392);
  });

  it("上方也越界时钳制到顶边距", () => {
    const p = computePopoverPosition({ left: 400, top: 20, width: 200, height: 40 }, { width: 420, height: 300 }, viewport);
    // 放到上方 20-300-8=-288 → 至少被放到下方 20+40+8=68；再 max(margin, 68)
    expect(p.top).toBeCloseTo(Math.max(8, 68));
  });
});
