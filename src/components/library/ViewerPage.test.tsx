/**
 * ViewerPage 视频识别回归测试（指导书 §7.1/§7.2）：
 *  - MIME 为 video/mp4 且 durationMs=null 时仍渲染 VideoPlayer（旧逻辑用 durationMs!=null 判断会漏掉导入失败时长为空的视频）。
 *  - 胶片条文字使用与属性面板一致的 isVideoAsset 判断。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import ViewerPage from "@/components/library/ViewerPage";
import { useLibraryStore } from "@/stores/libraryStore";
import { ensureVideoProxy } from "@/api/video";
import type { Asset } from "@/types/asset";

vi.mock("@/api/thumbnail", () => ({
  getThumbnailUrl: vi.fn().mockResolvedValue("asset://thumb/hd.webp"),
  toFileUrl: (p: string) => `asset://${p}`,
}));
vi.mock("@/api/tags", () => ({
  removeTags: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/api/video", () => ({
  ensureVideoProxy: vi.fn(),
  toProxyFileUrl: (p: string) => `asset://proxy/${p}`,
}));
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
}));

function mkAsset(over: Partial<Asset> = {}): Asset {
  return {
    id: 1,
    filePath: "d:/lib/v1.mp4",
    fileName: "v1.mp4",
    fileExt: "mp4",
    fileSize: 1024,
    mimeType: "video/mp4",
    width: 1920,
    height: 1080,
    durationMs: null, // 关键：导入时长读取失败
    videoCodec: null,
    audioCodec: null,
    takenAt: null,
    createdAt: 1,
    modifiedAt: 1,
    hash: null,
    placeholderPath: null,
    hdThumbnailPath: null,
    camera: null,
    lens: null,
    iso: null,
    aperture: null,
    shutter: null,
    focal: null,
    tags: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useLibraryStore.setState({
    items: [mkAsset()],
    total: 1,
    loading: false,
    error: null,
    filter: {
      assetType: "all",
      untaggedOnly: false,
      tagId: null,
      search: "",
      sortBy: "created_at",
      sortDir: "desc",
      trashOnly: false,
    },
  });
  (useLibraryStore.getState() as unknown as { loadMore: () => void }).loadMore = vi.fn();
});

describe("ViewerPage 视频识别（§7.1）", () => {
  it("MIME 为 video/mp4 且 durationMs=null 仍渲染 VideoPlayer", () => {
    const { container } = render(<ViewerPage asset={mkAsset()} onClose={vi.fn()} />);
    // 渲染 <video> 元素（VideoPlayer），而非 <img>
    expect(container.querySelector("video")).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("图片素材渲染 <img> 而非 VideoPlayer", async () => {
    const img = mkAsset({ id: 2, mimeType: "image/jpeg", fileExt: "jpg", filePath: "d:/lib/i.jpg", fileName: "i.jpg", durationMs: null });
    useLibraryStore.setState({ items: [img], total: 1 });
    const { container } = render(<ViewerPage asset={img} onClose={vi.fn()} />);
    // 高清缩略图异步加载后渲染 <img>；等待出现的 img 元素
    await waitFor(() => expect(screen.getByRole("img", { name: "i.jpg" })).toBeInTheDocument());
    expect(container.querySelector("video")).toBeNull();
  });

  it("胶片条对无占位图的视频显示「视频」而非「图片」（同一类型判断）", () => {
    render(<ViewerPage asset={mkAsset()} onClose={vi.fn()} />);
    // 当前素材 placeholderPath=null → 胶片条退化为文字
    const text = screen.getAllByText("视频");
    expect(text.length).toBeGreaterThan(0);
  });

  it("§8.3 原文件播放失败 → 生成兼容代理并切换到代理源", async () => {
    vi.mocked(ensureVideoProxy).mockResolvedValue({
      assetId: 1,
      variant: "h264_mp4",
      status: "ready",
      path: "D:/data/proxies/1_h264_mp4.mp4",
      error: null,
      updatedAt: 1,
    });
    const { container } = render(<ViewerPage asset={mkAsset()} onClose={vi.fn()} />);
    const video = container.querySelector("video") as HTMLVideoElement;
    expect(video).not.toBeNull();
    // 触发播放错误
    video.dispatchEvent(new Event("error"));
    await waitFor(() => expect(ensureVideoProxy).toHaveBeenCalledWith(1, "h264_mp4"));
    await waitFor(() =>
      expect((container.querySelector("video") as HTMLVideoElement).getAttribute("src")).toContain("asset://proxy/"),
    );
  });
});
