/**
 * 媒体元数据格式化（指导书 §11.5 空值语义 + §11.6 字段分组）：
 *  把 Asset 的媒体字段按「通用 / 图片 / 视频」分组，并区分六种空值状态，避免把所有空值渲染成同一个短横线。
 *
 * 状态 → 文案：
 *  - notApplicable  字段不适用于当前媒体 → 不适用
 *  - notProvided    文件没有提供该信息   → 未提供
 *  - notScanned     尚未执行探测         → 未读取
 *  - scanFailed     探测执行失败         → 读取失败
 *  - unavailable    平台无法判断/不支持  → 不可用
 *  - empty          字段存在但内容为空   → 空
 */
import type { Asset } from "@/types/asset";
import { isVideoAsset } from "@/utils/assetKind";

export type MetaValueStatus = "notApplicable" | "notProvided" | "notScanned" | "scanFailed" | "unavailable" | "empty";

export interface MetaField {
  key: string;
  label: string;
  text: string;
  status: MetaValueStatus;
  /** 长路径 / 原始 JSON 可复制 */
  copyable?: boolean;
}

const STATUS_TEXT: Record<MetaValueStatus, string> = {
  notApplicable: "不适用",
  notProvided: "未提供",
  notScanned: "未读取",
  scanFailed: "读取失败",
  unavailable: "不可用",
  empty: "空",
};

export function statusText(status: MetaValueStatus): string {
  return STATUS_TEXT[status];
}

/** 素材是否已完成媒体探测（探测版本 > 0 或已写入扫描时间 = 成功/部分；metadata_error 非空 = 失败）。 */
export function probeState(a: Asset): { scanned: boolean; failed: boolean } {
  const scanned = !!a.metadataScannedAt || (a.metadataVersion != null && a.metadataVersion > 0);
  const failed = !!a.metadataError;
  return { scanned, failed };
}

/** 格式化媒体值：空 → 状态文案；有值 → 展示文本。value 为字节/毫秒等 raw 值经 caller 转换后传入。 */
export function formatValue(value: unknown, renderPositive: (v: unknown) => string): string {
  if (value == null || value === "") return "未提供";
  return renderPositive(value);
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatFileSize(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleString();
}

/** 旋转后显示尺寸：横竖画幅按 rotation%180 是否 90 判断 */
export function displaySize(width: number | null, height: number | null, rotation?: number | null): string {
  if (width == null || height == null) return "未提供";
  if (rotation != null && rotation % 180 !== 0) return `${height}×${width}（旋转 ${rotation}°）`;
  return `${width}×${height}`;
}

function field(label: string, text: string, copyable = false, status: MetaValueStatus = "notProvided"): MetaField {
  return { key: label, label, text, status, copyable };
}

/** 通用字段（图片/视频都适用）。 */
export function buildCommonFields(a: Asset): MetaField[] {
  const { failed } = probeState(a);
  return [
    field("文件名", a.fileName, true),
    field("完整路径", a.filePath, true),
    field("文件大小", a.fileSize != null ? formatFileSize(a.fileSize) : "未提供"),
    field("扩展名", a.fileExt || "未提供"),
    field("MIME", a.mimeType || "未提供"),
    field("素材类型", isVideoAsset(a) ? "视频" : "图片"),
    field("入库时间", a.createdAt ? formatDate(a.createdAt) : "未提供"),
    field("修改时间", a.modifiedAt ? formatDate(a.modifiedAt) : "未提供"),
    field("元数据状态", failed ? "读取失败" : a.metadataScannedAt ? "已读取" : "未读取"),
  ];
}

/** 图片字段：仅对图片素材展示（否则整组不显示）。 */
export function buildImageFields(a: Asset): MetaField[] {
  return [
    field("分辨率", a.width != null && a.height != null ? displaySize(a.width, a.height, a.rotation) : "未提供"),
    field("方向/旋转", a.rotation != null ? `${a.rotation}°` : "未提供"),
    field("色彩空间", a.colorSpace || "未提供"),
    field("位深", a.bitDepth != null ? `${a.bitDepth} bit` : "未提供"),
    field("像素格式", a.pixelFormat || "未提供"),
    field("拍摄时间", a.takenAt ? formatDate(a.takenAt) : "未提供"),
    field("相机机身", a.camera || "未提供"),
    field("镜头", a.lens || "未提供"),
    field("焦距", a.focal != null ? `${a.focal}mm` : "未提供"),
    field("光圈", a.aperture != null ? `f/${a.aperture}` : "未提供"),
    field("快门", a.shutter ? `${a.shutter}s` : "未提供"),
    field("ISO", a.iso != null ? String(a.iso) : "未提供"),
  ];
}

/** 视频字段：仅对视频素材展示。 */
export function buildVideoFields(a: Asset): MetaField[] {
  return [
    field("分辨率", a.width != null && a.height != null ? displaySize(a.width, a.height, a.rotation) : "未提供"),
    field("时长", a.durationMs != null ? formatDuration(a.durationMs) : "未读取"),
    field("容器格式", a.containerFormat || "未提供"),
    field("视频编码", a.videoCodec || "未提供"),
    field("Profile", a.videoProfile || "未提供"),
    field("像素格式", a.pixelFormat || "未提供"),
    field("位深", a.bitDepth != null ? `${a.bitDepth} bit` : "未提供"),
    field("帧率", a.frameRate != null ? `${a.frameRate.toFixed(2)} fps` : "未提供"),
    field("视频码率", a.videoBitRate != null ? `${mb(a.videoBitRate)}` : "未提供"),
    field("色彩范围", a.colorRange || "未提供"),
    field("色彩空间", a.colorSpace || "未提供"),
    field("传输曲线", a.colorTransfer || "未提供"),
    field("色彩原色", a.colorPrimaries || "未提供"),
    field("旋转", a.rotation != null ? `${a.rotation}°` : "未提供"),
    field("音频编码", a.audioCodec || "未提供"),
    field("采样率", a.audioSampleRate != null ? `${(a.audioSampleRate / 1000).toFixed(1)} kHz` : "未提供"),
    field("声道数", a.audioChannels != null ? String(a.audioChannels) : "未提供"),
    field("声道布局", a.audioLayout || "未提供"),
  ];
}
