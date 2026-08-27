/**
 * PageErrorBoundary 测试（指导书 A-1 / A-4）：子组件运行时异常不白屏，显示错误页。
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactElement } from "react";
import PageErrorBoundary from "@/components/common/PageErrorBoundary";

function Bomb(): ReactElement {
  throw new Error("boom");
}

function Good(): ReactElement {
  return <div>正常内容</div>;
}

describe("PageErrorBoundary", () => {
  it("子组件正常时渲染内容", () => {
    render(
      <PageErrorBoundary onReset={() => {}} onBack={() => {}}>
        <Good />
      </PageErrorBoundary>,
    );
    expect(screen.getByText("正常内容")).toBeInTheDocument();
  });

  it("子组件抛异常时显示错误页而非白屏", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <PageErrorBoundary onReset={() => {}} onBack={() => {}}>
        <Bomb />
      </PageErrorBoundary>,
    );
    expect(screen.getByText("页面暂时无法显示")).toBeInTheDocument();
    expect(screen.getByText("重新加载")).toBeInTheDocument();
    expect(screen.getByText("返回素材库")).toBeInTheDocument();
    spy.mockRestore();
  });

  it("点击「返回素材库」触发 onBack", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onBack = vi.fn();
    render(
      <PageErrorBoundary onReset={() => {}} onBack={onBack}>
        <Bomb />
      </PageErrorBoundary>,
    );
    fireEvent.click(screen.getByText("返回素材库"));
    expect(onBack).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("点击「重新加载」触发 onReset 且复位边界", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onReset = vi.fn();
    render(
      <PageErrorBoundary onReset={onReset} onBack={() => {}}>
        <Bomb />
      </PageErrorBoundary>,
    );
    fireEvent.click(screen.getByText("重新加载"));
    expect(onReset).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
