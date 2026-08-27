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
  // 媒体元数据（指导书 §7.3/§7.4，后端探测为事实源；V12 迁移新增列）
  mediaKind?: string | null;
  containerFormat?: string | null;
  videoProfile?: string | null;
  pixelFormat?: string | null;
  bitDepth?: number | null;
  frameRate?: number | null;
  videoBitRate?: number | null;
  colorRange?: string | null;
  colorSpace?: string | null;
  colorTransfer?: string | null;
  colorPrimaries?: string | null;
  audioSampleRate?: number | null;
  audioChannels?: number | null;
  audioLayout?: string | null;
  rotation?: number | null;
  mediaMetadataJson?: string | null;
  metadataVersion?: number | null;
  metadataScannedAt?: number | null;
  metadataError?: string | null;
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
  facetFilters?: FacetTagFilter[];
  excludeTagIds?: number[];
  metadataFilters?: MetadataFilter[];
  search?: string;
  /** 排序字段（R-21）：createdAt（默认）| takenAt | modifiedAt | name | size | resolution */
  sortBy?: "created_at" | "taken_at" | "modified_at" | "name" | "size" | "resolution";
  /** desc（默认）| asc */
  sortDir?: "desc" | "asc";
  /** true = 查回收站（R-22） */
  trashOnly?: boolean;
  /** 布尔表达式树（P4 queryExpr）：存在时后端优先走表达式编译 */
  expr?: import("./queryExpr").QueryExpr;
  offset?: number;
  limit?: number;
}

export interface FacetTagFilter {
  facetKey: string;
  tagIds: number[];
  mode: "any" | "all";
  includeDescendants: boolean;
}

export type MetadataFilterKey =
  | "folder"
  | "taken_month"
  | "camera"
  | "lens"
  | "iso"
  | "aperture"
  | "shutter"
  | "focal"
  | "file_ext"
  | "mime_type"
  | "width"
  | "height"
  | "resolution"
  | "aspect_ratio"
  | "file_size"
  | "duration_ms"
  | "taken_at"
  | "created_at"
  | "modified_at"
  | "video_codec"
  | "audio_codec";

export type MetadataOp =
  | "eq"
  | "in"
  | "contains"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between";

export type MetadataValue = string | number;

export interface MetadataFilter {
  key: MetadataFilterKey;
  op: MetadataOp;
  /** 单值操作符（eq / contains / gt / gte / lt / lte）使用 */
  value?: MetadataValue;
  /** in 操作符使用 */
  values?: MetadataValue[];
  /** between 操作符使用 */
  min?: MetadataValue;
  max?: MetadataValue;
}

export interface MetadataFacetItem {
  value: string;
  label: string;
  count: number;
}

export interface MetadataFacet {
  /** 分面展示键（可为 folder/duration/taken_month 等，未必是筛选 key） */
  key: string;
  displayName: string;
  description: string;
  items: MetadataFacetItem[];
}

export interface AssetPage {
  items: Asset[];
  total: number;
  hasMore: boolean;
}

/** 分面标签条件（ResolvedSearchQuery 内，tagIds 为后端解析结果） */
export interface ResolvedFacetFilter {
  facetKey: string;
  tagIds: number[];
  /** any（同分面内 OR，默认）| all */
  mode: "any" | "all";
  includeDescendants: boolean;
}

/** 执行对象：后端/前端统一查询协议（P0 contract-v1 §3） */
export interface ResolvedSearchQuery {
  search: string;
  assetType: AssetType;
  untaggedOnly: boolean;
  facetFilters: ResolvedFacetFilter[];
  excludeTagIds: number[];
  missingFacetKeys: string[];
  metadataFilters: MetadataFilter[];
  sortBy: "created_at" | "taken_at" | "modified_at" | "name" | "size" | "resolution";
  sortDir: "desc" | "asc";
}

/** AI 输出的标签条件（SearchIntent 内，text 为文字，不含 id） */
export interface SearchIntentTag {
  facetKey: string;
  text: string;
  includeDescendants?: boolean;
}

/** SearchIntent：AI 自然语言解析产物（P0 contract-v1 §2） */
export interface SearchIntent {
  search?: string;
  assetType?: AssetType;
  tags?: SearchIntentTag[];
  excludeTags?: SearchIntentTag[];
  metadata?: MetadataFilter[];
  sortBy?: ResolvedSearchQuery["sortBy"];
  sortDir?: "desc" | "asc";
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
