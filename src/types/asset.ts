/** 素材类型（与 Rust db/assets.rs 对齐，camelCase 序列化） */

export interface Asset {
  id: number;
  filePath: string;
  fileName: string;
  fileExt: string;
  fileSize: number;
  mimeType: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  takenAt: number | null;
  createdAt: number;
  modifiedAt: number;
  hash: string | null;
  placeholderPath: string | null;
  hdThumbnailPath: string | null;
  // EXIF 元信息（PRD 5.5，入库自动提取）
  camera: string | null;
  lens: string | null;
  iso: number | null;
  aperture: number | null;
  shutter: string | null;
  focal: number | null;
  tags: import("./tag").Tag[];
}

export type AssetType = "all" | "image" | "video";

export interface AssetFilter {
  assetType?: AssetType;
  untaggedOnly?: boolean;
  tagId?: number;
  search?: string;
  offset?: number;
  limit?: number;
}

export interface AssetPage {
  items: Asset[];
  total: number;
  hasMore: boolean;
}

export interface ImportResult {
  imported: number;
  failed: number;
  duplicates: number;
  errors: string[];
}
