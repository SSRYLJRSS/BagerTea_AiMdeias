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
