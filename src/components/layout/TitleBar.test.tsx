/**
 * TitleBar 标题栏测试（指导书 §3.3 / §12.1）：
 *  - 左侧顺序为 logo → 设置；
 *  - 软件名不显示（删除「茶包素材 BagerTea V2」文本）；
 *  - 右侧只显示最小化、最大化/还原、关闭三个按钮；
 *  - 设置/窗口控制按钮不携带 data-tauri-drag-region（点击即拖拽的回归门禁）；
 *  - 点击设置按钮派发 app:navigate=settings；
 *  - 非 Tauri 环境（jsdom）不抛异常。
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import TitleBar from "@/components/layout/TitleBar";

describe("TitleBar（指导书 §3.3）", () => {
  it("软件名不显示，左侧顺序为 logo → 设置", () => {
    const { container } = render(<TitleBar />);
    expect(screen.queryByText(/茶包素材 BagerTea V2/)).not.toBeInTheDocument();
    expect(screen.queryByText(/BagerTea V2/i)).not.toBeInTheDocument();

    // logo（img alt=茶包素材）在设置按钮之前
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    const settings = screen.getByRole("button", { name: "设置" });
    expect((img as HTMLElement).compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it("窗口控制只显示三个按钮：最小化/最大化或还原/关闭", () => {
    render(<TitleBar />);
    const minBtn = screen.getByRole("button", { name: "最小化" });
    const maxBtn = screen.getByRole("button", { name: /最大化|还原/ });
    const closeBtn = screen.getByRole("button", { name: "关闭" });
    expect(minBtn).toBeInTheDocument();
    expect(maxBtn).toBeInTheDocument();
    expect(closeBtn).toBeInTheDocument();
    // 设置 + 三个窗口控制 = 恰好 4 个按钮，无多余入口；四个标签互不相同
    const labels = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(labels).toHaveLength(4);
    expect(new Set(labels).size).toBe(4);
    // 窗口控制顺序为 最小化 → 最大化/还原 → 关闭
    expect(minBtn.compareDocumentPosition(maxBtn) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(maxBtn.compareDocumentPosition(closeBtn) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it("设置按钮在左侧（位于窗口控制之前）且无 data-tauri-drag-region", () => {
    render(<TitleBar />);
    const settings = screen.getByRole("button", { name: "设置" });
    const close = screen.getByRole("button", { name: "关闭" });
    // 设置不携带拖拽标记
    expect(settings.getAttribute("data-tauri-drag-region")).toBeNull();
    // 设置位于关闭按钮之前（同排左侧）
    expect((settings.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);
    // 窗口控制按钮也不携带拖拽标记
    expect(screen.getByRole("button", { name: "最小化" }).getAttribute("data-tauri-drag-region")).toBeNull();
    expect(close.getAttribute("data-tauri-drag-region")).toBeNull();
  });

  it("点击设置派发 app:navigate=settings", () => {
    const listener = vi.fn();
    window.addEventListener("app:navigate", listener);
    render(<TitleBar />);
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(listener).toHaveBeenCalledTimes(1);
    const detail = (listener.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toBe("settings");
    window.removeEventListener("app:navigate", listener);
  });

  it("非 Tauri 环境渲染不抛异常（jsdom 无窗口 API）", () => {
    expect(() => render(<TitleBar />)).not.toThrow();
  });
});