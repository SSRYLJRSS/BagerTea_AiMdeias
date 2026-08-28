/** FB2-01 档位 → 缩略图请求尺寸分级测试（§9.6） */
import { describe, expect, it } from "vitest";
import { thumbSizeForCell } from "@/utils/thumbSize";

describe("thumbSizeForCell（FB2-01 分级）", () => {
  it("190px → 512（2×DPR=380，512 足够）", () => {
    expect(thumbSizeForCell(190)).toBe(512);
  });

  it("191px → 1024（跨过 190 阈值）", () => {
    expect(thumbSizeForCell(191)).toBe(1024);
  });

  it("大格子 → 1024", () => {
    expect(thumbSizeForCell(480)).toBe(1024);
  });

  it("极小格子 → 512", () => {
    expect(thumbSizeForCell(96)).toBe(512);
  });
});