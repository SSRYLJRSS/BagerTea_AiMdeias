/** 设置与网盘账号 */

export type ApiMode = "openai" | "anthropic";

/** 一套 API 配置档案（一个中转站/服务商） */
export interface ApiProfile {
  id: string;
  name: string;
  apiMode: ApiMode;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface AiSettings {
  /** 多套 API 配置（中转站），打标只走激活那套 */
  profiles: ApiProfile[];
  /** 当前激活档案 id */
  activeProfile: string;
  autoTagging: boolean;
  videoTagging: boolean;
  localModelTier: "light" | "standard";
  batchLimit: number;
}

/** 标签分类（PRD 5.5）：分类=父标签，hint 参与 AI 提示词 */
export interface TagCategory {
  name: string;
  hint: string;
  /** 单选（最多 1 个标签） */
  single: boolean;
  /** 每类标签数量上限（多选时生效） */
  max: number;
}

export interface Settings {
  ai: AiSettings;
  theme: "system" | "light" | "dark";
  thumbnailCacheMb: number;
  /** 标签分类（设置页可管理） */
  tagCategories: TagCategory[];
  /** 总库位置（R-32）；空 = 原位索引模式 */
  libraryRoot: string;
}

export interface CloudAccount {
  id: number;
  provider: "baidu" | "quark";
  name: string;
  bound: boolean;
  expiresAt: number | null;
}
