/** PendingList 测试：固定动作头部 + §10（FB-04）卡片内视频播放。
 *  - hover 300ms 后在**卡片容器内**出现 video（无 fixed dialog / 无浮层）；
 *  - 离开 350ms 暂停并卸载；快速扫过不创建实例；
 *  - 编码失败退回封面并提示「双击打开」；
 *  - 双击回调 onOpenItem；视频控件阻止冒泡；
 *  - 入库运行中禁用操作且不挂载视频。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import PendingList from "@/components/import/PendingList";
import type { ImportPlanItem } from "@/api/import";

vi.mock("@/api/preview", () => ({
  getPreviewUrl: (p: string) => Promise.resolve(`asset://preview/${p}`),
}));
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
}));

// LazyThumb 依赖 IntersectionObserver（jsdom 无实现）
vi.stubGlobal(
  "IntersectionObserver",
  class {
    cb: IntersectionObserverCallback;
    constructor(cb: IntersectionObserverCallback) {
      this.cb = cb;
    }
    observe() {
      this.cb([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  },
);

const items: ImportPlanItem[] = [
  { path: "d:/p/a.jpg", kind: "image", size: 1024 * 512 },
  { path: "d:/p/b.mp4", kind: "video", size: 1024 * 1024 * 5 },
  { path: "d:/p/c.mov", kind: "video", size: 1024 * 1024 * 4 },
];

function renderGrid(props: { onOpenItem?: (p: string) => void; running?: boolean } = {}) {
  const onRemove = vi.fn();
  const onOpenItem = props.onOpenItem ?? vi.fn();
  const utils = render(
    <PendingList
      items={items}
      running={props.running ?? false}
      onRemove={onRemove}
      onOpenItem={onOpenItem}
      onAddFiles={() => {}}
      onAddFolder={() => {}}
      onClear={() => {}}
    />,
  );
  // 切到网格视图
  fireEvent.click(screen.getByRole("button", { name: "缩略图视图" }));
  return { ...utils, onRemove, onOpenItem };
}

/** 通过完整路径定位一张卡片（卡片容器 = 标题的 relative 祖先；title 用 item.path） */
function cardOf(path: string): HTMLElement {
  const title = screen.getByTitle(path);
  const card = title.closest(".group") as HTMLElement;
  expect(card).toBeTruthy();
  return card;
}

/** 推进 fake timer 并 flush React 状态更新 */
function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PendingList 固定动作头部", () => {
  it("清单非空时提供添加文件/添加文件夹/清空入口与数量/大小", () => {
    render(<PendingList items={items} running={false} onRemove={() => {}} />);
    expect(screen.getByRole("button", { name: "添加文件" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加文件夹" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "清空清单" })).toBeInTheDocument();
    expect(screen.getByText(/3 项/)).toBeInTheDocument();
  });

  it("点击添加文件/文件夹/清空调用对应事件（不直接 invoke）", () => {
    const onAddFiles = vi.fn();
    const onAddFolder = vi.fn();
    const onClear = vi.fn();
    render(
      <PendingList
        items={items}
        running={false}
        onRemove={() => {}}
        onAddFiles={onAddFiles}
        onAddFolder={onAddFolder}
        onClear={onClear}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
    fireEvent.click(screen.getByRole("button", { name: "添加文件夹" }));
    fireEvent.click(screen.getByRole("button", { name: "清空清单" }));
    expect(onAddFiles).toHaveBeenCalledTimes(1);
    expect(onAddFolder).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("入库运行中禁用添加/清空", () => {
    const onAddFiles = vi.fn();
    const onClear = vi.fn();
    render(
      <PendingList items={items} running onRemove={() => {}} onAddFiles={onAddFiles} onClear={onClear} />,
    );
    expect(screen.getByRole("button", { name: "添加文件" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "添加文件夹" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "清空清单" })).toBeDisabled();
  });
});

describe("PendingList §10 卡片内视频播放（FB-04）", () => {
  it("hover 300ms 后在卡片容器内出现 video，且无 fixed dialog 浮层", () => {
    const { container } = renderGrid();
    const card = cardOf("d:/p/b.mp4");
    expect(card.querySelector("video")).toBeNull(); // 未激活不挂载

    fireEvent.mouseEnter(card);
    advance(300);
    const video = card.querySelector("video");
    expect(video).not.toBeNull(); // 卡片内
    expect(video?.closest(".group")).toBe(card); // 原卡片容器内（非浮层）
    expect(container.querySelector("[role='dialog']")).toBeNull();
    expect(video?.muted).toBe(true);
    expect(video?.playsInline).toBe(true);
    expect(video?.getAttribute("preload")).toBe("metadata");
  });

  it("离开 350ms 后暂停并卸载视频层（src 清空）", () => {
    renderGrid();
    const card = cardOf("d:/p/b.mp4");
    fireEvent.mouseEnter(card);
    advance(300);
    const video = card.querySelector("video") as HTMLVideoElement;
    expect(video).not.toBeNull();

    fireEvent.mouseLeave(card);
    advance(400);
    expect(card.querySelector("video")).toBeNull();
  });

  it("快速扫过不创建视频实例（enter 延迟内 leave 不激活）", () => {
    renderGrid();
    const card = cardOf("d:/p/b.mp4");
    fireEvent.mouseEnter(card);
    fireEvent.mouseLeave(card); // <300ms 离开
    advance(500);
    expect(card.querySelector("video")).toBeNull();
  });

  it("编码失败退回封面并提示「双击打开」", () => {
    renderGrid();
    const card = cardOf("d:/p/b.mp4");
    fireEvent.mouseEnter(card);
    advance(300);
    const video = card.querySelector("video") as HTMLVideoElement;
    expect(video).not.toBeNull();
    fireEvent.error(video);
    // 视频层替换为失败提示（封面 + 提示）
    expect(card.querySelector("video")).toBeNull();
    expect(card.textContent).toContain("无法播放");
  });

  it("同时最多 1 个视频（新激活暂停旧实例，不新增多个实例）", () => {
    renderGrid();
    const b = cardOf("d:/p/b.mp4");
    const c = cardOf("d:/p/c.mov");
    fireEvent.mouseEnter(b);
    advance(300);
    expect(b.querySelector("video")).not.toBeNull();
    // 快速滑到 c：b 还未离开（leave=350ms）时就激活 c
    fireEvent.mouseEnter(c);
    advance(300);
    const cVideo = c.querySelector("video") as HTMLVideoElement | null;
    expect(cVideo).not.toBeNull();
  });

  it("双击调用 onOpenItem；移除按钮阻止冒泡", () => {
    const onOpenItem = vi.fn();
    renderGrid({ onOpenItem });
    const card = cardOf("d:/p/b.mp4");
    fireEvent.doubleClick(card);
    expect(onOpenItem).toHaveBeenCalledWith("d:/p/b.mp4");
  });

  it("入库运行中不启动 hover 预览（禁用 intent）", () => {
    renderGrid({ running: true });
    const card = cardOf("d:/p/b.mp4");
    fireEvent.mouseEnter(card);
    advance(400);
    expect(card.querySelector("video")).toBeNull();
  });
});
