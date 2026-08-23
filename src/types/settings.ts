/** 设置与网盘账号 */

export type ApiMode = "openai" | "anthropic";

/** 部署类型（P3-01a）：cloud 云端服务商 | local 本机 OpenAI 兼容服务（Ollama/LM Studio） */
export type ProfileKind = "cloud" | "local";

/** 一套 API 配置档案（一个中转站/服务商） */
export interface ApiProfile {
  id: string;
  name: string;
  apiMode: ApiMode;
  /** 部署类型；旧数据缺省视为 cloud */
  kind?: ProfileKind;
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
  /** 一键安装的下载源偏好（"auto" = 测速选最快；旧数据缺省视为 auto） */
  ollamaSourceId: string;
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

/** 用户自定义下载源（即时落库；改造方案） */
export interface CustomSource {
  id: string;
  label: string;
  url: string;
}

export interface Settings {
  ai: AiSettings;
  theme: "system" | "light" | "dark";
  thumbnailCacheMb: number;
  /** 标签分类（设置页可管理） */
  tagCategories: TagCategory[];
  /** 总库位置（R-32）；空 = 原位索引模式 */
  libraryRoot: string;
  /** 回收站保留天数（R-22）；0 = 不自动清理 */
  trashRetentionDays: number;
  /** Ollama 一键下载的自定义源（即时落库；旧数据缺省空） */
  customDownloadSources: CustomSource[];
  /** Ollama 模型下载代理（拉起 serve 时注入 HTTPS_PROXY；空 = 不用代理） */
  modelDownloadProxy: string;
}

export interface CloudAccount {
  id: number;
  provider: "baidu" | "quark";
  name: string;
  bound: boolean;
  expiresAt: number | null;
}
