/**
 * VideoHoverOverlay 测试（指导书 F-6）：hover 激活后的卡片内播放生命周期、失败降级。
 * jsdom 的 HTMLMediaElement 未实现 play/pause，此处打桩。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import VideoHoverOverlay from "@/components/media/VideoHoverOverlay";

// ── jsdom 补齐：HTMLMediaElement.play/pause 打桩 ──
const playMock = vi.fn(() => Promise.resolve());
const pauseMock = vi.fn();
beforeAll(() => {
  Object.defineProperty(HTMLMediaElement.prototype, "play", { configurable: true, value: playMock });
  Object.defineProperty(HTMLMediaElement.prototype, "pause", { configurable: true, value: pauseMock });
});
beforeEach(() => {
  playMock.mockClear();
  pauseMock.mockClear();
});

describe("VideoHoverOverlay", () => {
  it("渲染 <video>（muted/playsInline/autoPlay）并尝试播放", () => {
    render(<VideoHoverOverlay src="asset://v.mp4" coverUrl={null} fileName="v.mp4" />);
    const video = document.querySelector("video") as HTMLVideoElement;
    expect(video).not.toBeNull();
    expect(video.getAttribute("src")).toBe("asset://v.mp4");
    expect(video.muted).toBe(true);
    expect(video.hasAttribute("playsinline")).toBe(true);
    expect(video.hasAttribute("autoplay")).toBe(true);
  });

  it("播放失败（error）回退封面并显示轻量错误文案", () => {
    render(<VideoHoverOverlay src="asset://bad.mp4" coverUrl="asset://cover.jpg" fileName="v.mp4" />);
    const video = document.querySelector("video") as HTMLVideoElement;
    fireEvent.error(video, new Event("error"));
    expect(screen.getByText("预览失败")).toBeInTheDocument();
    // 封面 img 出现
    expect(screen.getByAltText("v.mp4")).toBeInTheDocument();
  });

  it("卸载时暂停（离开即停）", () => {
    const { unmount } = render(<VideoHoverOverlay src="asset://v.mp4" coverUrl={null} fileName="v.mp4" />);
    unmount();
    expect(pauseMock).toHaveBeenCalled();
  });

  it("覆盖原卡片：absolute inset-0 且 pointer-events none", () => {
    const { container } = render(<VideoHoverOverlay src="asset://v.mp4" coverUrl={null} fileName="v.mp4" />);
    const overlay = container.firstChild as HTMLElement;
    expect(overlay).toHaveClass("absolute");
    expect(overlay).toHaveClass("inset-0");
    expect(overlay.style.pointerEvents).toBe("none");
  });
});
