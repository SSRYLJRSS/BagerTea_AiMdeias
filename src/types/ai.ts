/** AI 打标（批次管理 + 确认流） */

/** 打标模式；auto = 建批时按激活档案 kind 解析为 cloud/local（P3-01a） */
export type AiMode = "cloud" | "local" | "manual" | "auto";

export interface AiBatch {
  id: number;
  /** interrupted：应用重启/中断时遗留的 processing 批次（可一键续跑，阶段 5 §8.2）
   *  undone：批次撤销已完成（D-4，不再显示可点击撤销） */
  status: "pending" | "processing" | "done" | "cancelled" | "interrupted" | "undone";
  mode: AiMode;
  total: number;
  processed: number;
  confirmed: number;
  createdAt: number;
}

/** 分类标签：{ 分类名: [标签...] }（PRD 5.5） */
export type CategorizedTags = Record<string, string[]>;

export interface AiSuggestion {
  id: number;
  batchId: number;
  assetId: number;
  assetPath: string;
  /** B-3/B-4：素材 MIME（前端判断批次是否含视频是否需要提示开启视频打标） */
  mimeType: string | null;
  suggestedTags: CategorizedTags;
  status: "pending" | "confirmed" | "rejected" | "modified";
  confirmedTags: CategorizedTags;
  /** 单条打标失败原因（v6：失败详情落库，前端展示） */
  lastError: string | null;
  createdAt: number;
  // FB5-05（§7.6）：一句话描述。AI 建议值 / 审核后确认值 / 素材当前值。
  suggestedDescription?: string;
  confirmedDescription?: string | null;
  currentDescription?: string;
}

export interface AiSuggestionItem {
  id: number;
  suggestionId: number;
  assetId: number;
  facetKey: string;
  rawName: string;
  normalizedName: string;
  tagId: number | null;
  confidence: number | null;
  decision: "pending" | "accepted" | "modified" | "rejected";
  decisionReason: string | null;
  createdAt: number;
}

/** FB6 需求一：AI 打标页内进度 UI 状态（由 aiStore 数据派生；进度事件只经页面内唯一
 *  onAiProgress 订阅写入 aiStore，本类型不再触发第二个事件监听）。 */
export type AiTaggingUiState =
  | { phase: "idle" }
  | { phase: "starting"; total: number }
  | { phase: "running"; processed: number; total: number; currentAssetId?: number }
  | { phase: "cancelling"; processed: number; total: number }
  | { phase: "done"; processed: number; total: number }
  | { phase: "error"; message: string; processed: number; total: number };

export interface ModelStatus {
  tier: "light" | "standard";
  state: "not_installed" | "downloading" | "ready" | "error";
  /** 0..1（downloading 时） */
  progress: number;
  sizeMb: number;
  localPath: string | null;
}
