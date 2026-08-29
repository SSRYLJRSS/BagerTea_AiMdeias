/**
 * AssetCard 回归测试（指导书 §6.1/§13.1）：
 *  - 渲染树不含 <video>（素材库禁止视频 hover/隐藏播放）；
 *  - 不含 fixed 大图 popover（role=dialog）；不创建任何媒体浮层；
 *  - 双击仍调用 onPreview；
 *  - 缩略图、格式/时长角标、选中勾选正常显示。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import AssetCard from "@/components/library/AssetCard";
import { useSettingsStore, DEFAULT_APPEARANCE } from "@/stores/settingsStore";
import type { Settings } from "@/types/settings";
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

/** §12：让 hover 预览处于关闭态（素材库两级开关都关）。构造最小可用 settings，不依赖 store 已加载。 */
function disableHoverPreview() {
  const base = useSettingsStore.getState().settings;
  const appearance = base?.appearance ?? DEFAULT_APPEARANCE;
  useSettingsStore.setState({
    settings: {
      ...(base ?? mkMinimalSettings()),
      appearance: { ...appearance, hoverPreview: { ...appearance.hoverPreview, enabled: false, inLibraryGrid: false } },
    },
  });
}

/** 最小可用完整 Settings（测试用，字段不全会触发 TS 但仍走 normalize 兜底）。 */
function mkMinimalSettings(): Settings {
  return {
    ai: {
      profiles: [],
      activeProfile: "",
      autoTagging: false,
      videoTagging: false,
      videoTaggingMode: "cover",
      videoFrameCount: 3,
      localModelTier: "light",
      batchLimit: 500,
      ollamaSourceId: "auto",
    },
    theme: "system",
    thumbnailCacheMb: 2048,
    tagCategories: [],
    aiFacetConfigs: [],
    libraryRoot: "",
    trashRetentionDays: 30,
    customDownloadSources: [],
    modelDownloadProxy: "",
    appearance: DEFAULT_APPEARANCE,
  };
}

beforeEach(() => {
  useSettingsStore.setState({ settings: null, previewAppearance: null });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** FB2-08（§16.5）：开启色条两级开关。 */
function enableColorStrip() {
  const base = useSettingsStore.getState().settings;
  const appearance = base?.appearance ?? DEFAULT_APPEARANCE;
  useSettingsStore.setState({
    settings: {
      ...(base ?? mkMinimalSettings()),
      appearance: { ...appearance, colorStrip: { ...appearance.colorStrip, enabled: true, showInLibraryGrid: true } },
    },
  });
}

describe("AssetCard §6.1 + FB2-03（素材库 hover 原位视频预览）", () => {
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

  // FB2-08（FX-07）：色条渲染与设置联动
  it("色条开启且有 palette 时渲染 role=img 色条；palette 为 null 时不渲染", () => {
    enableColorStrip();
    const palette = [
      { hex: "#1b2a3c", r: 27, g: 42, b: 60, ratio: 0.6 },
      { hex: "#e6dfc8", r: 230, g: 223, b: 200, ratio: 0.4 },
    ];
    const { container, rerender } = render(
      <AssetCard
        asset={mkAsset({ mimeType: "image/jpeg", palette } as Partial<Asset>)}
        index={0}
        thumbSize={512}
        selected={false}
        onSelect={noop}
        onPreview={noop}
        onContextMenu={noop}
      />,
    );
    expect(container.querySelector('[role="img"]')).not.toBeNull();
    expect(container.querySelector(".ui-colorstrip")).not.toBeNull();

    rerender(
      <AssetCard
        asset={mkAsset({ mimeType: "image/jpeg", palette: null } as Partial<Asset>)}
        index={0}
        thumbSize={512}
        selected={false}
        onSelect={noop}
        onPreview={noop}
        onContextMenu={noop}
      />,
    );
    expect(container.querySelector(".ui-colorstrip")).toBeNull();
  });

  it("视频卡片：hover 未触发时无 <video>、无 dialog、无 fixed 浮层（默认）", () => {
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

  it("视频卡片：hover 300ms 后原位出现 <video>，为 absolute inset-0 而非 fixed；无 fixed 浮层", () => {
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
    const card = screen.getByRole("button");
    fireEvent.mouseEnter(card);
    // 300ms intent 前不出现
    act(() => vi.advanceTimersByTime(280));
    expect(container.querySelector("video")).toBeNull();
    // 300ms 后出现
    act(() => vi.advanceTimersByTime(30));
    const v = container.querySelector("video");
    expect(v).not.toBeNull();
    // §12.4 承诺：卡内原位播放，absolute inset-0，绝非 fixed
    expect(v?.className).toContain("absolute");
    expect(v?.className).toContain("inset-0");
    expect(v?.className).not.toContain("fixed");
    // 不制造 fixed 浮层、无 dialog
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    const fixed = Array.from(container.querySelectorAll("*")).filter(
      (el) => (el as HTMLElement).style?.position === "fixed" || (el as HTMLElement).className?.includes?.("fixed"),
    );
    expect(fixed).toHaveLength(0);
  });

  it("视频卡片：设置关闭 hoverPreview 后，hover 300ms 仍无 <video>", () => {
    disableHoverPreview();
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
    const card = screen.getByRole("button");
    fireEvent.mouseEnter(card);
    act(() => vi.advanceTimersByTime(400));
    expect(container.querySelector("video")).toBeNull();
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