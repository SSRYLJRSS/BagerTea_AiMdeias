/**
 * AssetCard 回归测试（指导书 §6.1/§13.1）：
 *  - 渲染树不含 <video>（素材库禁止视频 hover/隐藏播放）；
 *  - 不含 fixed 大图 popover（role=dialog）；不创建任何媒体浮层；
 *  - 双击仍调用 onPreview；
 *  - 缩略图、格式/时长角标、选中勾选正常显示。
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import AssetCard from "@/components/library/AssetCard";
import type { Asset } from "@/types/asset";

vi.mock("@/api/thumbnail", () => ({
  getThumbnailUrl: vi.fn().mockResolvedValue("asset://hd.webp"),
  toFileUrl: (p: string) => `asset://${p}`,
}));

// Thumbnail 用 IntersectionObserver 触发高清生成；jsdom 缺失，补最小桩
vi.stubGlobal("IntersectionObserver", class {
  cb: IntersectionObserverCallback;
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
});

const mkAsset = (over: Partial<Asset> = {}): Asset => ({
  id: 1,
  filePath: "d:/lib/a1.jpg",
  fileName: "a1.jpg",
  fileExt: "jpg",
  fileSize: 100,
  mimeType: "image/jpeg",
  width: 800,
  height: 600,
  durationMs: null,
  videoCodec: null,
  audioCodec: null,
  takenAt: null,
  createdAt: 1,
  modifiedAt: 1,
  hash: null,
  placeholderPath: "thumb1.jpg",
  hdThumbnailPath: null,
  camera: null,
  lens: null,
  iso: null,
  aperture: null,
  shutter: null,
  focal: null,
  tags: [],
  ...over,
});

const noop = () => {};

describe("AssetCard §6.1（素材库禁止 hover 媒体预览）", () => {
  it("图片卡片渲染树无 <video>、无 role=dialog popover、无 position:fixed 预览层", () => {
    const { container } = render(
      <AssetCard
        asset={mkAsset({ mimeType: "image/jpeg", durationMs: null })}
        index={0}
        thumbSize={512}
        selected={false}
        onSelect={noop}
        onPreview={noop}
        onContextMenu={noop}
      />,
    );
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    const fixed = Array.from(container.querySelectorAll("*")).filter(
      (el) => (el as HTMLElement).style?.position === "fixed" || (el as HTMLElement).className?.includes?.("fixed"),
    );
    expect(fixed).toHaveLength(0);
    // 缩略图仍在
    expect(container.querySelector("img")).not.toBeNull();
  });

  it("视频卡片渲染树同样无隐藏 <video>、无 overlay 浮层（素材库不承担播放）", () => {
    const { container } = render(
      <AssetCard
        asset={mkAsset({ mimeType: "video/mp4", durationMs: 5000, fileExt: "mp4" })}
        index={0}
        thumbSize={512}
        selected={false}
        onSelect={noop}
        onPreview={noop}
        onContextMenu={noop}
      />,
    );
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    // 时长角标仍显示
    expect(screen.getByText("0:05")).toBeInTheDocument();
  });

  it("双击仍调用 onPreview（进入 Viewer 的入口保持不变）", () => {
    const preview = vi.fn();
    render(
      <AssetCard
        asset={mkAsset()}
        index={0}
        thumbSize={512}
        selected={false}
        onSelect={noop}
        onPreview={preview}
        onContextMenu={noop}
      />,
    );
    const card = screen.getByRole("button");
    fireEvent.doubleClick(card);
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it("单击调用 onSelect，右键调用 onContextMenu", () => {
    const select = vi.fn();
    const ctx = vi.fn();
    render(
      <AssetCard
        asset={mkAsset()}
        index={0}
        thumbSize={512}
        selected={false}
        onSelect={select}
        onPreview={noop}
        onContextMenu={ctx}
      />,
    );
    const card = screen.getByRole("button");
    fireEvent.click(card);
    expect(select).toHaveBeenCalledTimes(1);
    fireEvent.contextMenu(card);
    expect(ctx).toHaveBeenCalledTimes(1);
  });

  it("选中态渲染勾选角标与 aria-selected", () => {
    const { container } = render(
      <AssetCard
        asset={mkAsset()}
        index={0}
        thumbSize={512}
        selected
        onSelect={noop}
        onPreview={noop}
        onContextMenu={noop}
      />,
    );
    expect(screen.getByRole("button").getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector(".rounded-full")).not.toBeNull(); // 勾选圆形角标
  });
});