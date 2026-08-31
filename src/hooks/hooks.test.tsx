import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useElementSize } from "@/hooks/hooks";

let layoutReady = false;

class ZeroFirstResizeObserver {
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe() {
    // 复现 WebView2 冷启动：只回报一次 0x0，父级完成布局后不再补发 observer 事件。
    this.callback(
      [{ contentRect: { width: 0, height: 0 } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }

  unobserve() {}
  disconnect() {}
}

function SizeProbe() {
  const { ref, width, height } = useElementSize<HTMLDivElement>();
  return (
    <div ref={ref}>
      <output aria-label="size">{width}x{height}</output>
    </div>
  );
}

describe("useElementSize 冷启动尺寸恢复", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    layoutReady = false;
    vi.stubGlobal("ResizeObserver", ZeroFirstResizeObserver);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      width: layoutReady ? 960 : 0,
      height: layoutReady ? 640 : 0,
      top: 0,
      left: 0,
      right: layoutReady ? 960 : 0,
      bottom: layoutReady ? 640 : 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }));
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => layoutReady ? 960 : 0);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => layoutReady ? 640 : 0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("首次 observer 只有 0x0 时，布局就绪后通过 rAF 重测到真实尺寸", () => {
    render(<SizeProbe />);
    expect(screen.getByLabelText("size")).toHaveTextContent("0x0");

    layoutReady = true;
    act(() => vi.advanceTimersByTime(20));

    expect(screen.getByLabelText("size")).toHaveTextContent("960x640");
  });
});
