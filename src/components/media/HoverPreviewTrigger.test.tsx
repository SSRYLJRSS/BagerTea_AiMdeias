import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, act } from "@testing-library/react";
import HoverPreviewTrigger from "@/components/media/HoverPreviewTrigger";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("HoverPreviewTrigger", () => {
  it("渲染 children，hover 停留 300ms 后显示浮层内容", () => {
    const { container } = render(
      <HoverPreviewTrigger content={<div>预览内容</div>}>
        <span>卡片</span>
      </HoverPreviewTrigger>,
    );
    expect(screen.getByText("卡片")).toBeInTheDocument();
    expect(screen.queryByText("预览内容")).not.toBeInTheDocument();

    fireEvent.mouseEnter(container.firstElementChild as Element);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByText("预览内容")).toBeInTheDocument();
  });

  it("快速扫过（<300ms）不触发浮层", () => {
    const { container } = render(
      <HoverPreviewTrigger content={<div>预览内容</div>}>
        <span>卡片</span>
      </HoverPreviewTrigger>,
    );
    fireEvent.mouseEnter(container.firstElementChild as Element);
    fireEvent.mouseLeave(container.firstElementChild as Element);
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByText("预览内容")).not.toBeInTheDocument();
  });

  it("离开后延迟 350ms 关闭浮层", () => {
    const { container } = render(
      <HoverPreviewTrigger content={<div>预览内容</div>}>
        <span>卡片</span>
      </HoverPreviewTrigger>,
    );
    fireEvent.mouseEnter(container.firstElementChild as Element);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByText("预览内容")).toBeInTheDocument();
    fireEvent.mouseLeave(container.firstElementChild as Element);
    expect(screen.getByText("预览内容")).toBeInTheDocument(); // 仍在停留期
    act(() => vi.advanceTimersByTime(350));
    expect(screen.queryByText("预览内容")).not.toBeInTheDocument();
  });

  it("disabled 时不激活浮层", () => {
    const { container } = render(
      <HoverPreviewTrigger disabled content={<div>预览内容</div>}>
        <span>卡片</span>
      </HoverPreviewTrigger>,
    );
    fireEvent.mouseEnter(container.firstElementChild as Element);
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByText("预览内容")).not.toBeInTheDocument();
  });
});
