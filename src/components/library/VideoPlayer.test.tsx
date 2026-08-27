import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import VideoPlayer from "@/components/library/VideoPlayer";

describe("VideoPlayer 控件（指导书 §6.5）", () => {
  it("渲染 video 元素与控制器按钮（带 aria-label/title）", () => {
    const { container } = render(<VideoPlayer src="asset://v/mp4" fileName="demo.mp4" />);
    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    expect(video!.getAttribute("src")).toBe("asset://v/mp4");
    expect(video!.getAttribute("playsinline")).not.toBeNull();

    expect(screen.getByRole("button", { name: /播放|暂停/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "后退 5 秒" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "前进 5 秒" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /静音|取消静音/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "全屏" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "播放进度" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "音量" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "倍速" })).toBeInTheDocument();
    expect(screen.getByText("0:00 / 0:00")).toBeInTheDocument();
  });

  it("倍速菜单含 0.5/1/1.5/2x", () => {
    render(<VideoPlayer src="asset://v/mp4" fileName="demo.mp4" />);
    const sel = screen.getByRole("combobox", { name: "倍速" }) as HTMLSelectElement;
    const opts = [...sel.options].map((o) => o.value);
    expect(opts).toEqual(["0.5", "1", "1.5", "2"]);
  });

  it("§6.2 上报视频测量指标（canPlayType 矩阵 + 网络/就绪状态）", () => {
    const onMetrics = vi.fn();
    render(<VideoPlayer src="asset://v/mp4" fileName="demo.mp4" onMetrics={onMetrics} />);
    // mount 时上报一次
    expect(onMetrics).toHaveBeenCalled();
    const m = onMetrics.mock.calls[0][0];
    expect(m.canPlayType).toBeTypeOf("object");
    expect(m).toHaveProperty("networkState");
    expect(m).toHaveProperty("readyState");
  });
});
