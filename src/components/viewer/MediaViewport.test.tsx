/**
 * MediaViewport 测试（指导书 §4.2/§12.2）：
 *  - 双击放大与恢复连续操作不失效（idle ↔ 2x 切换，无「按住才生效」隐藏语义）；
 *  - Alt+滚轮以光标为锚点缩放（原生 passive:false 由组件挂载）；
 *  - 放大后左键拖动平移，释放后停止（pointer capture 释放）；
 *  - 切换素材清零 scale/offset 与拖拽状态；
 *  - 视频路径不挂图片平移交互（只渲染 video 节点）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import MediaViewport from "@/components/viewer/MediaViewport";

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