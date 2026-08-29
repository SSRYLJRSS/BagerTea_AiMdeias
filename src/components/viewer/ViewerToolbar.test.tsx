/** FB3-04（§6.3）：工具栏语义 —— 「全屏浏览」按钮存在；「详情」不得再作为按钮名 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ViewerToolbar from "@/components/viewer/ViewerToolbar";

const noop = () => undefined;

describe("ViewerToolbar（FB3-04）", () => {
  it("存在「全屏浏览」按钮（aria-label），点击调用 onToggleFullscreen", () => {
    const onFs = vi.fn();
    render(
      <ViewerToolbar
        fileName="a.jpg"
        position="1 / 10"
        detailsOpen
        onToggleDetails={noop}
        fullscreen={false}
        onToggleFullscreen={onFs}
        onClose={noop}
      />,
    );
    const btn = screen.getByRole("button", { name: "全屏浏览" });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onFs).toHaveBeenCalledTimes(1);
  });

  it("全屏时按钮文案切换为「退出全屏浏览」", () => {
    render(
      <ViewerToolbar
        fileName="a.jpg"
        position="1 / 10"
        detailsOpen
        onToggleDetails={noop}
        fullscreen
        onToggleFullscreen={noop}
        onClose={noop}
      />,
    );
    expect(screen.getByRole("button", { name: "退出全屏浏览" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "全屏浏览" })).not.toBeInTheDocument();
  });

  it("「详情」不得再作为按钮名；属性栏开关改叫「信息」", () => {
    render(
      <ViewerToolbar
        fileName="a.jpg"
        position=""
        detailsOpen={false}
        onToggleDetails={noop}
        fullscreen={false}
        onToggleFullscreen={noop}
        onClose={noop}
      />,
    );
    // aria-label 是「显示信息面板」；按钮可见文本是「信息」
    expect(screen.getByRole("button", { name: "显示信息面板" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /详情/ })).not.toBeInTheDocument();
  });

  it("信息开关点击调用 onToggleDetails", () => {
    const onToggle = vi.fn();
    render(
      <ViewerToolbar
        fileName="a.jpg"
        position=""
        detailsOpen
        onToggleDetails={onToggle}
        fullscreen={false}
        onToggleFullscreen={noop}
        onClose={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "隐藏信息面板" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
