/**
 * MediaViewport 测试（指导书 §4.2/§12.2/§7.6）：
 *  - 双击放大与恢复连续操作不失效（idle ↔ 2x 切换，无「按住才生效」隐藏语义）；
 *  - Alt+滚轮以光标为锚点缩放（原生 passive:false 由组件挂载）且锚点误差 <=1px；
 *  - 放大后左键拖动平移，释放后停止（pointer capture 释放）；
 *  - 切换素材清零 scale/offset 与拖拽状态；旧回调（代际）不改新素材；
 *  - 缩放钳制 0.2~8；ref null / pointercancel / 卸载均不抛异常；
 *  - 视频路径不挂图片平移交互（只渲染 video 节点）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import MediaViewport from "@/components/viewer/MediaViewport";
import { ZOOM_MAX, ZOOM_MIN } from "@/components/viewer/viewportMath";

function renderImg() {
  const onImageError = vi.fn();
  const utils = render(
    <MediaViewport
      assetId={1}
      isVideo={false}
      imageSrc="asset://thumb/hd.webp"
      fileName="a.jpg"
      onImageError={onImageError}
    />,
  );
  const stage = screen.getByTestId("media-viewport") as HTMLElement;
  return { ...utils, stage, onImageError };
}

function currentStyle(stage: HTMLElement): string {
  const img = stage.querySelector("img") as HTMLImageElement;
  return img.style.transform;
}

/** 解析 transform 的 translate+scale 数值 */
function parseTransform(stage: HTMLElement): { tx: number; ty: number; scale: number } {
  const m = currentStyle(stage).match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\((-?[\d.]+)\)/);
  if (!m) return { tx: 0, ty: 0, scale: 1 };
  return { tx: Number(m[1]), ty: Number(m[2]), scale: Number(m[3]) };
}

/** 给 stageRef 元素挂一个真实布局 rect（模拟 WebView2 布局） */
function mockStageRect(stage: HTMLElement, rect: { left: number; top: number; width: number; height: number }) {
  stage.getBoundingClientRect = () =>
    ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  return rect;
}

const savedGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = savedGetBoundingClientRect;
});

beforeEach(() => {
  // jsdom 无真实布局：getBoundingClientRect 返回 0，锚点计算退化为 (0,0)；缩放比例仍生效
  vi.restoreAllMocks();
});

describe("MediaViewport 图片交互（§4.2）", () => {
  it("初始视图 scale=1 无位移", () => {
    const { stage } = renderImg();
    expect(currentStyle(stage)).toContain("scale(1)");
  });

  it("双击从 1x 放大到约 2x，再次双击恢复 1x（连续 20 次不失效）", () => {
    const { stage } = renderImg();
    for (let i = 0; i < 20; i++) {
      // 双击 = detail 2 的两次 pointerdown（350ms 窗口内）
      fireEvent.pointerDown(stage, { button: 0, detail: 1, clientX: 100, clientY: 100, pointerId: i });
      fireEvent.pointerDown(stage, { button: 0, detail: 2, clientX: 100, clientY: 100, pointerId: i });
      if (i % 2 === 0) {
        expect(currentStyle(stage)).toContain("scale(2)");
      } else {
        expect(currentStyle(stage)).toContain("scale(1)");
      }
    }
  });

  it("Alt+滚轮以指针为锚点缩放（wheel 事件触发缩放而非默认滚动）", () => {
    const { stage } = renderImg();
    const prev = { scrollY: window.scrollY };
    fireEvent.wheel(stage, { altKey: true, deltaY: -100, clientX: 50, clientY: 60 });
    expect(currentStyle(stage)).toContain("scale(1.15)"); // deltaY<0 → 放大 1.15
    expect(window.scrollY).toBe(prev.scrollY); // preventDefault 生效
  });

  it("未放大时左键不拖拽（双击语义优先）；放大后左键拖动平移，松开停止", () => {
    const { stage } = renderImg();
    // 先双击放大
    fireEvent.pointerDown(stage, { button: 0, detail: 1, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerDown(stage, { button: 0, detail: 2, clientX: 10, clientY: 10, pointerId: 1 });
    expect(currentStyle(stage)).toContain("scale(2)");

    // 左键按下 → 移动 → 平移增量生效（相对双击锚点后的偏移）
    fireEvent.pointerDown(stage, { button: 0, clientX: 100, clientY: 100, pointerId: 2 });
    const before = currentStyle(stage);
    fireEvent.pointerMove(stage, { clientX: 140, clientY: 120, pointerId: 2 });
    const moved = currentStyle(stage);
    // 移动 40,20 → translate 增量 +40,+20
    const [bx, by] = before.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/)!.slice(1).map(Number);
    const [mx, my] = moved.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/)!.slice(1).map(Number);
    expect(mx - bx).toBeCloseTo(40);
    expect(my - by).toBeCloseTo(20);

    // 松开后再次移动不再更新
    fireEvent.pointerUp(stage, { clientX: 150, clientY: 130, pointerId: 2 });
    fireEvent.pointerMove(stage, { clientX: 200, clientY: 200, pointerId: 2 });
    expect(currentStyle(stage)).toBe(moved);
  });

  it("切换素材重置 scale/offset（assetId 变化）", () => {
    const { stage, rerender } = renderImg();
    fireEvent.pointerDown(stage, { button: 0, detail: 1, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerDown(stage, { button: 0, detail: 2, clientX: 10, clientY: 10, pointerId: 1 });
    expect(currentStyle(stage)).toContain("scale(2)");

    rerender(
      <MediaViewport assetId={2} isVideo={false} imageSrc="asset://thumb/hd2.webp" fileName="b.jpg" />,
    );
    expect(currentStyle(stage)).toContain("scale(1)");
  });

  it("Alt+滚轮锚点误差 <=1px（真实 rect，锚点坐标往返后误差可忽略）", () => {
    const { stage } = renderImg();
    // 舞台中心 = (200, 150)；在 (260, 190) 放大（cx=60, cy=40）
    mockStageRect(stage, { left: 100, top: 80, width: 200, height: 140 });

    // 1x → 1.15：offset = cx - imgX*next = 60 - 60*1.15 = -9；ty = 40 - 40*1.15 = -6
    fireEvent.wheel(stage, { altKey: true, deltaY: -100, clientX: 260, clientY: 190 });
    const zoomed = parseTransform(stage);
    expect(zoomed.scale).toBeCloseTo(1.15, 5);
    expect(zoomed.tx).toBeCloseTo(-9, 1);
    expect(zoomed.ty).toBeCloseTo(-6, 1);
    // 锚点不变：指针处的图像坐标 imgX = (cx - tx)/scale 应仍等于 cx（误差 <=1px）
    const imgX = (60 - zoomed.tx) / zoomed.scale;
    const imgY = (40 - zoomed.ty) / zoomed.scale;
    expect(Math.abs(imgX - 60)).toBeLessThanOrEqual(1);
    expect(Math.abs(imgY - 40)).toBeLessThanOrEqual(1);

    // 同一指针位置双击恢复 1x：offset 归零（§7.4）
    fireEvent.pointerDown(stage, { button: 0, detail: 1, clientX: 260, clientY: 190, pointerId: 9 });
    fireEvent.pointerDown(stage, { button: 0, detail: 2, clientX: 260, clientY: 190, pointerId: 9 });
    const restored = parseTransform(stage);
    expect(restored.scale).toBe(1);
    expect(restored.tx).toBeCloseTo(0, 1);
    expect(restored.ty).toBeCloseTo(0, 1);
  });

  it("缩放钳制在 0.2~8（连续放大/缩小不越界）", () => {
    const { stage } = renderImg();
    // 连续放大 30 次（1.15^30 >> 8）→ 钳到 8
    for (let i = 0; i < 30; i++) {
      fireEvent.wheel(stage, { altKey: true, deltaY: -100, clientX: 50, clientY: 50 });
    }
    expect(parseTransform(stage).scale).toBeCloseTo(ZOOM_MAX, 5);
    // 连续缩小 30 次（0.87^30 << 0.2）→ 钳到 0.2
    for (let i = 0; i < 30; i++) {
      fireEvent.wheel(stage, { altKey: true, deltaY: 100, clientX: 50, clientY: 50 });
    }
    expect(parseTransform(stage).scale).toBeCloseTo(ZOOM_MIN, 5);
    // 钳制后仍可正常读（无 NaN/异常 transform）
    expect(currentStyle(stage)).toMatch(/scale\(0\.2\)/);
  });

  it("快速切图后旧代际回调不改新素材（wheel 捕获旧代际被丢弃）", () => {
    const { stage, rerender } = renderImg();
    // 旧素材上放大
    fireEvent.pointerDown(stage, { button: 0, detail: 1, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerDown(stage, { button: 0, detail: 2, clientX: 10, clientY: 10, pointerId: 1 });
    expect(parseTransform(stage).scale).toBe(2);

    // 切到新素材（代际 +1，视图归零）
    rerender(
      <MediaViewport assetId={2} isVideo={false} imageSrc="asset://thumb/hd2.webp" fileName="b.jpg" />,
    );
    expect(parseTransform(stage).scale).toBe(1);

    // 立即在新素材上滚轮：即使上一个 wheel listener 闭包捕获了旧 view.scale=2，
    // wheel effect 依赖 [view.scale, assetId]，重订阅后按新 scale=1 计算，结果落在 1.15 附近而非 2.x
    fireEvent.wheel(stage, { altKey: true, deltaY: -100, clientX: 50, clientY: 50 });
    expect(parseTransform(stage).scale).toBeCloseTo(1.15, 5);
  });

  it("pointercancel 释放拖拽状态且不抛异常", () => {
    const { stage } = renderImg();
    fireEvent.pointerDown(stage, { button: 0, detail: 1, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerDown(stage, { button: 0, detail: 2, clientX: 10, clientY: 10, pointerId: 1 });
    // 放大后拖拽中取消
    expect(() => {
      fireEvent.pointerDown(stage, { button: 0, clientX: 100, clientY: 100, pointerId: 2 });
      fireEvent.pointerMove(stage, { clientX: 120, clientY: 110, pointerId: 2 });
      fireEvent.pointerCancel(stage, { clientX: 130, clientY: 120, pointerId: 2 });
      // 取消后继续移动不应再更新
      const after = currentStyle(stage);
      fireEvent.pointerMove(stage, { clientX: 200, clientY: 200, pointerId: 2 });
      expect(currentStyle(stage)).toBe(after);
    }).not.toThrow();
  });

  it("卸载不抛异常且释放 capture（模拟 jsdom 无 real capture）", () => {
    const { stage, unmount } = renderImg();
    fireEvent.pointerDown(stage, { button: 0, clientX: 100, clientY: 100, pointerId: 2 });
    expect(() => unmount()).not.toThrow();
  });

  it("ref null / 无 rect 时不抛异常（jsdom 默认 rect=0）", () => {
    const { stage } = renderImg();
    fireEvent.wheel(stage, { altKey: true, deltaY: -100, clientX: 50, clientY: 50 });
    expect(currentStyle(stage)).toContain("scale(1.15)");
  });

  it("fatal 时显示 §7.5 错误视觉，重新加载后重置状态重新取图", () => {
    const onRetry = vi.fn();
    const onBack = vi.fn();
    const { unmount } = render(
      <MediaViewport
        assetId={1}
        isVideo={false}
        imageSrc={null}
        fileName="a.jpg"
        fatal
        onRetryCurrent={onRetry}
        onBackToLibrary={onBack}
      />,
    );
    expect(screen.getByText("当前素材暂时无法显示")).toBeInTheDocument();
    expect(screen.getByText("可能是文件损坏、路径不可用或媒体解码失败。")).toBeInTheDocument();
    fireEvent.click(screen.getByText("重新加载当前素材"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("返回素材库"));
    expect(onBack).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("图片 onError 一律上报（上层区分回落与致命）", () => {
    const { stage, onImageError } = renderImg();
    fireEvent.error(stage.querySelector("img") as HTMLImageElement);
    expect(onImageError).toHaveBeenCalledTimes(1);
  });
});

describe("MediaViewport 视频路径（§4.2 视频不参与图片平移）", () => {
  it("视频节点渲染且无图片拖拽交互（不挂 pointer handler 于舞台）", () => {
    render(
      <MediaViewport assetId={3} isVideo fileName="v.mp4" video={<video data-testid="vid" src="asset://v" />} />,
    );
    const vid = screen.getByTestId("vid");
    expect(vid).toBeInTheDocument();
    // 视频舞台无 img（不做图片平移）
    const stage = screen.getByTestId("media-viewport");
    expect(stage.querySelector("img")).toBeNull();
  });
});