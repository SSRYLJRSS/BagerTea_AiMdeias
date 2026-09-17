import { StrictMode, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { useHoverPreviewPlayback } from "@/hooks/useHoverPreviewPlayback";

function PlaybackHarness({ onFailed }: { onFailed: () => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useHoverPreviewPlayback(videoRef, { previewSeconds: 3, onFailed });

  return (
    <video
      ref={(node) => {
        videoRef.current = node;
        if (!node) return;
        Object.defineProperty(node, "duration", { configurable: true, value: 12 });
        Object.defineProperty(node, "readyState", { configurable: true, value: 1 });
      }}
      src="asset://video.mp4"
    />
  );
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useHoverPreviewPlayback", () => {
  it("媒体 metadata 在 effect 前已就绪时仍会启动播放", () => {
    const onFailed = vi.fn();
    const { container } = render(<PlaybackHarness onFailed={onFailed} />);
    const video = container.querySelector("video") as HTMLVideoElement;

    expect(video.play).toHaveBeenCalledTimes(1);
    expect(video.currentTime).toBeCloseTo(1.2, 5);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("StrictMode 重放 effect 时不会清掉媒体源", () => {
    const onFailed = vi.fn();
    const { container } = render(
      <StrictMode>
        <PlaybackHarness onFailed={onFailed} />
      </StrictMode>,
    );
    const video = container.querySelector("video") as HTMLVideoElement;

    expect(video.getAttribute("src")).toBe("asset://video.mp4");
    expect(video.play).toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("绑定监听前已经失败时会触发回退，而不是静默覆盖封面", () => {
    const onFailed = vi.fn();
    const video = document.createElement("video");
    Object.defineProperty(video, "error", { configurable: true, value: { code: 3 } });
    Object.defineProperty(video, "src", { configurable: true, value: "asset://broken.mp4" });

    function ExistingVideoHarness() {
      const videoRef = useRef<HTMLVideoElement | null>(video);
      useHoverPreviewPlayback(videoRef, { previewSeconds: 3, onFailed });
      return null;
    }

    render(<ExistingVideoHarness />);
    expect(onFailed).toHaveBeenCalledTimes(1);
  });
});
