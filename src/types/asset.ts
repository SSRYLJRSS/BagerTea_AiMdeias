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
  /** 多标签筛选（R-21，与 tagId 二选一） */
  tagIds?: number[];
  /** any（默认）| all（同时含全部标签） */
  tagsMode?: "any" | "all";
  search?: string;
  /** 排序字段（R-21）：createdAt（默认）| takenAt | size | resolution */
  sortBy?: "created_at" | "taken_at" | "size" | "resolution";
  /** desc（默认）| asc */
  sortDir?: "desc" | "asc";
  /** true = 查回收站（R-22） */
  trashOnly?: boolean;
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

/** 重复素材分组（M3-02）：assets 按 created_at 升序，首项最早（保留候选） */
export interface DupGroup {
  hash: string;
  assets: Asset[];
}

/** 打标操作流水（R-25，对应 db/tag_ops.rs TagOp） */
export interface TagOp {
  id: number;
  assetId: number;
  tagId: number;
  op: "add" | "remove";
  actor: "manual" | "ai_cloud" | "ai_local";
  batchId: number | null;
  createdAt: number;
  tagName: string;
  assetName: string;
}
