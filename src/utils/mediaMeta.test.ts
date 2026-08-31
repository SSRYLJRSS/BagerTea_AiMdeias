/**
 * mediaMeta 测试（指导书 §5.2 / §11.5）：空值语义、单位换算、字段分组稳定。
 */
import { describe, expect, it } from "vitest";
import {
  buildCommonFields,
  buildImageFields,
  buildVideoFields,
  displaySize,
  formatBitRate,
  formatDuration,
  formatFileSize,
  statusText,
} from "@/utils/mediaMeta";
import { isVideoAsset } from "@/utils/assetKind";
import type { Asset } from "@/types/asset";

function mkAsset(over: Partial<Asset> = {}): Asset {
  return {
    id: 1,
    filePath: "d:/lib/a.jpg",
    fileName: "a.jpg",
    fileExt: "jpg",
    fileSize: 2048,
    mimeType: "image/jpeg",
    width: 800,
    height: 600,
    durationMs: null,
    videoCodec: null,
    audioCodec: null,
    takenAt: null,
    createdAt: 1000,
    modifiedAt: 2000,
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

describe("mediaMeta 空值语义", () => {
  it("statusText 覆盖六种状态文案", () => {
    expect(statusText("notApplicable")).toBe("不适用");
    expect(statusText("notProvided")).toBe("未提供");
    expect(statusText("notScanned")).toBe("未读取");
    expect(statusText("scanFailed")).toBe("读取失败");
    expect(statusText("unavailable")).toBe("不可用");
    expect(statusText("empty")).toBe("空");
  });

  it("未探测素材：通用字段的文件名/路径有值，宽高为未提供", () => {
    const fields = buildCommonFields(mkAsset());
    const byKey = Object.fromEntries(fields.map((f) => [f.label, f]));
    expect(byKey["文件名"].text).toBe("a.jpg");
    expect(byKey["完整路径"].text).toBe("d:/lib/a.jpg");
    expect(byKey["文件大小"].text).toBe("2.0 KB");
    expect(byKey["素材类型"].text).toBe("图片");
  });

  it("视频元数据状态：metadata_scannedAt 存在 → 已读取；metadata_error → 读取失败", () => {
    const scanned = buildCommonFields(mkAsset({ metadataScannedAt: 123 }));
    expect(scanned.find((f) => f.label === "元数据状态")!.text).toBe("已读取");
    const failed = buildCommonFields(mkAsset({ metadataError: "probe timeout" }));
    expect(failed.find((f) => f.label === "元数据状态")!.text).toBe("读取失败");
    const notScanned = buildCommonFields(mkAsset());
    expect(notScanned.find((f) => f.label === "元数据状态")!.text).toBe("未读取");
  });
});

describe("mediaMeta 单位换算", () => {
  it("formatFileSize 分级", () => {
    expect(formatFileSize(500)).toBe("500 B");
    expect(formatFileSize(2048)).toBe("2.0 KB");
    expect(formatFileSize(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatFileSize(2 * 1024 * 1024 * 1024)).toBe("2.0 GB");
  });

  it("formatDuration 小时/分钟", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(65000)).toBe("1:05");
    expect(formatDuration(3661000)).toBe("1:01:01");
  });

  it("displaySize 考虑旋转（90° 横竖互换）", () => {
    expect(displaySize(1920, 1080, null)).toBe("1920×1080");
    expect(displaySize(1920, 1080, 90)).toBe("1080×1920（旋转 90°）");
  });

  it("formatBitRate 按量级显示 Mbps/kbps（bit/s 不误标为 MB）", () => {
    expect(formatBitRate(8_500_000)).toBe("8.50 Mbps");
    expect(formatBitRate(640_000)).toBe("640 kbps");
    expect(formatBitRate(500)).toBe("500 bps");
  });
});

describe("mediaMeta 字段分组（FB6 需求六：用户白名单）", () => {
  it("图片素材的 video 字段组包含视频专属字段（编码/码率），通用/图片组稳定", () => {
    const img = mkAsset();
    const videoFields = buildVideoFields(img);
    expect(videoFields.find((f) => f.label === "视频编码")!.text).toBe("未提供");
    const imageFields = buildImageFields(img);
    expect(imageFields.find((f) => f.label === "ISO")!.text).toBe("未提供");
  });

  it("视频素材 isVideoAsset / 分组标签正确", () => {
    const vid = mkAsset({ mimeType: "video/mp4", fileExt: "mp4", durationMs: null });
    expect(isVideoAsset(vid)).toBe(true);
    const videoFields = buildVideoFields(vid);
    expect(videoFields.find((f) => f.label === "时长")!.text).toBe("未读取");
  });

  it("图片白名单：不渲染方向/旋转、像素格式、位深", () => {
    const img = mkAsset({ rotation: 90, pixelFormat: "yuv420p", bitDepth: 8, width: 800, height: 600 });
    const labels = buildImageFields(img).map((f) => f.label);
    expect(labels).not.toContain("方向/旋转");
    expect(labels).not.toContain("旋转");
    expect(labels).not.toContain("像素格式");
    expect(labels).not.toContain("位深");
    // 分辨率不再拼接「旋转」说明
    expect(buildImageFields(img).find((f) => f.label === "分辨率")!.text).toBe("800×600");
  });

  it("视频白名单：覆盖 codec/profile/帧率/码率/色彩/音频，且不渲染像素格式、位深、旋转", () => {
    const vid = mkAsset({
      mimeType: "video/mp4",
      fileExt: "mp4",
      width: 3840,
      height: 2160,
      durationMs: 65_000,
      containerFormat: "mov,mp4,m4a",
      videoCodec: "hevc",
      videoProfile: "Main",
      frameRate: 29.97,
      videoBitRate: 8_500_000,
      colorRange: "tv",
      colorSpace: "bt709",
      colorTransfer: "bt709",
      colorPrimaries: "bt709",
      audioCodec: "aac",
      audioSampleRate: 48_000,
      audioChannels: 2,
      audioLayout: "stereo",
      rotation: 90,
      pixelFormat: "yuv420p10le",
      bitDepth: 10,
    });
    const fields = buildVideoFields(vid);
    const byLabel = (l: string) => fields.find((f) => f.label === l)!.text;
    expect(byLabel("分辨率")).toBe("3840×2160");
    expect(byLabel("视频编码")).toBe("hevc");
    expect(byLabel("Profile")).toBe("Main");
    expect(byLabel("帧率")).toBe("29.97 fps");
    expect(byLabel("视频码率")).toBe("8.50 Mbps");
    expect(byLabel("色彩范围")).toBe("tv");
    expect(byLabel("色彩空间")).toBe("bt709");
    expect(byLabel("传输曲线")).toBe("bt709");
    expect(byLabel("色彩原色")).toBe("bt709");
    expect(byLabel("音频编码")).toBe("aac");
    expect(byLabel("采样率")).toBe("48.0 kHz");
    expect(byLabel("声道数")).toBe("2");
    expect(byLabel("声道布局")).toBe("stereo");
    const labels = fields.map((f) => f.label);
    expect(labels).not.toContain("像素格式");
    expect(labels).not.toContain("位深");
    expect(labels).not.toContain("旋转");
  });

  it("缺失值诚实显示「未提供」，不伪造默认值", () => {
    const vid = mkAsset({ mimeType: "video/mp4", fileExt: "mp4" });
    const fields = buildVideoFields(vid);
    expect(fields.find((f) => f.label === "Profile")!.text).toBe("未提供");
    expect(fields.find((f) => f.label === "色彩范围")!.text).toBe("未提供");
    expect(fields.find((f) => f.label === "声道布局")!.text).toBe("未提供");
    expect(fields.find((f) => f.label === "视频码率")!.text).toBe("未提供");
  });
});
