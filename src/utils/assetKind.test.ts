/**
 * isVideoAsset 测试（指导书 B-4）：MIME 优先、时长兜底、扩展名最后兜底。
 */
import { describe, expect, it } from "vitest";
import { isImageAsset, isVideoAsset } from "@/utils/assetKind";

const v = (mimeType: string, durationMs: number | null, fileExt = "") => ({ mimeType, durationMs, fileExt });

describe("isVideoAsset", () => {
  it("MIME 为 video/* 且时长为空 -> 视频", () => {
    expect(isVideoAsset(v("video/mp4", null))).toBe(true);
  });

  it("MIME 为空/未知 但时长存在 -> 视频", () => {
    expect(isVideoAsset(v("image/jpeg", 5000))).toBe(true); // 时长非空时即使 MIME 是图片也视为视频
  });

  it("图片 MIME、时长为空 -> 非视频", () => {
    expect(isVideoAsset(v("image/jpeg", null, "jpg"))).toBe(false);
  });

  it("MIME 与时长均缺，扩展名视频兜底 -> 视频", () => {
    expect(isVideoAsset(v("", null, "MOV"))).toBe(true);
  });

  it("MIME 与时长均缺，非视频扩展名 -> 非视频", () => {
    expect(isVideoAsset(v("", null, "jpg"))).toBe(false);
  });

  it("isImageAsset 与 isVideoAsset 互补", () => {
    expect(isImageAsset(v("image/png", null))).toBe(true);
    expect(isImageAsset(v("video/mp4", null))).toBe(false);
  });
});
