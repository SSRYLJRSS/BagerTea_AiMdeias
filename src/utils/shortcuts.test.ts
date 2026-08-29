/** FB3-05（§7.4）：快捷键声明点纯函数单测 */
import { describe, expect, it } from "vitest";
import {
  isEditableTarget,
  isInsidePlayer,
  escapeShouldExitFullscreen,
  requestFullscreenSafe,
  IMAGE_ZOOM_MIN,
  IMAGE_ZOOM_MAX,
  WHEEL_ZOOM_STEP,
  DOUBLE_CLICK_ZOOM,
} from "@/utils/shortcuts";

describe("isEditableTarget（FB3-05）", () => {
  it("输入类元素返回 true；普通元素/null 返回 false", () => {
    expect(isEditableTarget(document.createElement("input"))).toBe(true);
    expect(isEditableTarget(document.createElement("textarea"))).toBe(true);
    expect(isEditableTarget(document.createElement("select"))).toBe(true);
    const editable = document.createElement("div");
    Object.defineProperty(editable, "isContentEditable", { value: true, configurable: true });
    expect(isEditableTarget(editable)).toBe(true);
    expect(isEditableTarget(document.createElement("button"))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe("isInsidePlayer（FB3-05）", () => {
  it("data-player-root 内的任意元素命中；外层不命中", () => {
    const root = document.createElement("div");
    root.setAttribute("data-player-root", "");
    const child = document.createElement("button");
    root.appendChild(child);
    expect(isInsidePlayer(child)).toBe(true);
    expect(isInsidePlayer(root)).toBe(true);
    expect(isInsidePlayer(document.createElement("div"))).toBe(false);
    expect(isInsidePlayer(null)).toBe(false);
  });
});

describe("escapeShouldExitFullscreen（FB3-04）", () => {
  it("无 fullscreenElement 时返回 false（Esc 走关闭查看器）", () => {
    expect(escapeShouldExitFullscreen()).toBe(false);
  });
});

describe("requestFullscreenSafe（FB3-04）", () => {
  it("元素为 null 或环境无 API 时返回 false 不抛错", async () => {
    await expect(requestFullscreenSafe(null)).resolves.toBe(false);
  });
  it("requestFullscreen 抛错时返回 false 不抛错（权限拒绝/不支持场景）", async () => {
    const el = document.createElement("div");
    (el as HTMLElement & { requestFullscreen?: unknown }).requestFullscreen = () =>
      Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
    await expect(requestFullscreenSafe(el)).resolves.toBe(false);
  });
});

describe("缩放常量（FB3-05 §7.2 注册表）", () => {
  it("范围与步进与产品要求一致：20%–800%，步进 1.15，双击 2x", () => {
    expect(IMAGE_ZOOM_MIN).toBe(0.2);
    expect(IMAGE_ZOOM_MAX).toBe(8);
    expect(WHEEL_ZOOM_STEP).toBe(1.15);
    expect(DOUBLE_CLICK_ZOOM).toBe(2);
  });
});
