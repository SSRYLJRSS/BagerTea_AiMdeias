/**
 * FB6 需求一：AiTaggingProgress 单测（AI 打标页内唯一进度块 + LED 滚动提示）。
 *  - starting 立即出现不确定进度条（不等后端事件、无 aria-valuenow / NaN%）；
 *  - running 按 processed/total 显示，当前素材名进入 LED 文案；total<=0 走不确定条；
 *  - cancelling/done/error 显示静态最终状态（无滚动副本，动画停止）；
 *  - 永远只有一个 role="progressbar"。
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import AiTaggingProgress from "@/components/ai/AiTaggingProgress";
import type { AiTaggingUiState } from "@/types/ai";

const starting: AiTaggingUiState = { phase: "starting", total: 120 };
const running: AiTaggingUiState = { phase: "running", processed: 3, total: 120, currentAssetId: 42 };
const runningNoTotal: AiTaggingUiState = { phase: "running", processed: 0, total: 0 };
const cancelling: AiTaggingUiState = { phase: "cancelling", processed: 5, total: 120 };
const done: AiTaggingUiState = { phase: "done", processed: 120, total: 120 };
const error: AiTaggingUiState = { phase: "error", message: "网络超时", processed: 3, total: 120 };

function bar(): HTMLElement {
  const bars = screen.getAllByRole("progressbar");
  expect(bars).toHaveLength(1);
  return bars[0];
}

/** 滚动阶段文案有静态 + 视觉两份副本（静态给 aria-live，视觉给滚动动画），断言「存在即可」 */
function expectLedText(text: string | RegExp) {
  const hits = typeof text === "string" ? screen.getAllByText(text) : screen.getAllByText(text);
  expect(hits.length).toBeGreaterThanOrEqual(1);
}

describe("AiTaggingProgress（FB6 需求一）", () => {
  it("starting：立即出现不确定进度条 + 连接文案（不等后端事件）", () => {
    render(<AiTaggingProgress state={starting} />);
    expect(bar()).not.toHaveAttribute("aria-valuenow");
    expectLedText("正在连接 AI 服务，请稍候 · 不会卡住");
  });

  it("running：百分比正确，LED 文案含当前素材名与计数", () => {
    render(<AiTaggingProgress state={running} currentAssetName="beach.jpg" />);
    expect(bar()).toHaveAttribute("aria-valuenow", "3");
    expectLedText(/「beach\.jpg」/);
    expectLedText(/第 4 \/ 120 张素材/);
  });

  it("running：找不到素材名时只显示计数；total<=0 走不确定条且不出现 NaN", () => {
    render(<AiTaggingProgress state={runningNoTotal} />);
    expect(bar()).not.toHaveAttribute("aria-valuenow");
    expectLedText("正在分析素材 · 请勿关闭窗口");
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });

  it("processed 超过 total 时按 total 钳制（不出 >100%）", () => {
    render(<AiTaggingProgress state={{ phase: "running", processed: 500, total: 120 }} />);
    expect(bar()).toHaveAttribute("aria-valuenow", "100");
  });

  it("cancelling：静态取消文案，无滚动副本", () => {
    render(<AiTaggingProgress state={cancelling} />);
    expect(bar()).toHaveAttribute("aria-valuenow", "4");
    expect(screen.getByText("取消已受理，当前图片完成后停止")).toBeInTheDocument();
    expect(document.querySelector(".ai-marquee-track")).toBeNull();
  });

  it("done：静态最终状态，滚动动画停止", () => {
    render(<AiTaggingProgress state={done} />);
    expect(bar()).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByText("打标结束 · 已处理 120 / 120")).toBeInTheDocument();
    expect(document.querySelector(".ai-marquee-track")).toBeNull();
  });

  it("error：失败文案用文字表达（含原因），无滚动副本", () => {
    render(<AiTaggingProgress state={error} />);
    expect(screen.getByText("打标失败：网络超时")).toBeInTheDocument();
    expect(document.querySelector(".ai-marquee-track")).toBeNull();
  });

  it("idle：不渲染任何内容（无第二进度条）", () => {
    const { container } = render(<AiTaggingProgress state={{ phase: "idle" }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("运行中滚动副本 aria-hidden，静态完整文案节点存在（aria-live）", () => {
    render(<AiTaggingProgress state={running} currentAssetName="beach.jpg" />);
    const track = document.querySelector(".ai-marquee-track") as HTMLElement;
    expect(track).not.toBeNull();
    expect(track.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelector(".ai-marquee-static[aria-live='polite']")).not.toBeNull();
  });
});
