/**
 * AssetInfoPanel 测试（指导书 §11.6）：失败态提供「重新读取媒体属性」，点击后重新探测并刷新素材。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import AssetInfoPanel from "@/components/library/AssetInfoPanel";
import { rescanAssetMetadata, rescanAssetPalette, getAsset } from "@/api/assets";
import type { Asset } from "@/types/asset";

vi.mock("@/api/assets", () => ({
  rescanAssetMetadata: vi.fn().mockResolvedValue({ total: 1, success: 1, failed: 0, skipped: 0 }),
  // FB2-08：单张重读顺带算色板；mock 不补这个函数会让 undefined.catch 直接抛错
  rescanAssetPalette: vi.fn().mockResolvedValue({ total: 1, success: 1, failed: 0, skipped: 0 }),
  getAsset: vi.fn(),
}));

function mkVideo(over: Partial<Asset> = {}): Asset {
  return {
    id: 1,
    filePath: "d:/lib/v.mp4",
    fileName: "v.mp4",
    fileExt: "mp4",
    fileSize: 1024,
    mimeType: "video/mp4",
    width: null,
    height: null,
    durationMs: null,
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
    metadataError: "探测超时",
    tags: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAsset).mockResolvedValue(mkVideo({ durationMs: 2000, width: 800, height: 600 }));
});

describe("AssetInfoPanel 媒体属性重读", () => {
  it("失败素材默认选中视频标签并显示读取失败语义", () => {
    render(<AssetInfoPanel asset={mkVideo()} />);
    expect(screen.getByText("时长")).toBeInTheDocument();
    expect(screen.getByText("未读取")).toBeInTheDocument(); // 缺失字段语义
  });

  it("点击「重新读取」调用 rescan + getAsset 并回调 onRefreshed", async () => {
    const onRefreshed = vi.fn();
    render(<AssetInfoPanel asset={mkVideo()} onRefreshed={onRefreshed} />);
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    await waitFor(() => expect(onRefreshed).toHaveBeenCalled());
    expect(rescanAssetMetadata).toHaveBeenCalledWith([1], "ids");
    // FB2-08（§14.7）：单张重算顺带算色板
    expect(rescanAssetPalette).toHaveBeenCalledWith([1], "ids");
    expect(getAsset).toHaveBeenCalledWith(1);
    expect(screen.getByText("已重新读取媒体属性")).toBeInTheDocument();
  });
});

/** FB6 需求六：面板按用户白名单渲染（不渲染方向/像素格式/位深；缺失值诚实显示） */
describe("AssetInfoPanel 字段白名单（FB6 需求六）", () => {
  it("视频属性不渲染像素格式、位深、旋转；有值字段如实显示", () => {
    render(
      <AssetInfoPanel
        asset={mkVideo({
          width: 3840,
          height: 2160,
          videoCodec: "hevc",
          videoProfile: "Main",
          frameRate: 29.97,
          videoBitRate: 8_500_000,
          colorRange: "tv",
          audioCodec: "aac",
          audioChannels: 2,
          audioLayout: "stereo",
          pixelFormat: "yuv420p10le",
          bitDepth: 10,
          rotation: 90,
        } as Partial<Asset>)}
      />,
    );
    expect(screen.getByText("视频编码")).toBeInTheDocument();
    expect(screen.getByText("3840×2160")).toBeInTheDocument();
    expect(screen.getByText("8.50 Mbps")).toBeInTheDocument();
    // 白名单外字段不出现
    expect(screen.queryByText("像素格式")).toBeNull();
    expect(screen.queryByText("位深")).toBeNull();
    expect(screen.queryByText("旋转")).toBeNull();
  });

  it("图片属性不渲染方向/旋转、像素格式、位深；缺 ISO 显示「未提供」", () => {
    render(
      <AssetInfoPanel
        asset={mkVideo({
          mimeType: "image/jpeg",
          fileExt: "jpg",
          metadataError: null,
          width: 800,
          height: 600,
          rotation: 90,
          pixelFormat: "yuv420p",
          bitDepth: 8,
        } as Partial<Asset>)}
      />,
    );
    expect(screen.getByText("800×600")).toBeInTheDocument();
    expect(screen.getByText("ISO")).toBeInTheDocument();
    expect(screen.getAllByText("未提供").length).toBeGreaterThanOrEqual(1); // 多个缺失字段均诚实显示
    expect(screen.queryByText(/方向/)).toBeNull();
    expect(screen.queryByText("像素格式")).toBeNull();
    expect(screen.queryByText("位深")).toBeNull();
  });

  it("探测失败时视频标签页显示「媒体探测失败」提示，缺失字段不伪造", () => {
    render(<AssetInfoPanel asset={mkVideo()} />);
    expect(screen.getByText("媒体探测失败，某些字段可能缺失。")).toBeInTheDocument();
    expect(screen.getByText("未读取")).toBeInTheDocument(); // 时长缺失 → 未读取（非默认值）
  });
});
