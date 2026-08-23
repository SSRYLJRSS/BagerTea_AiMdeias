/** AI 打标（批次管理 + 确认流） */

/** 打标模式；auto = 建批时按激活档案 kind 解析为 cloud/local（P3-01a） */
export type AiMode = "cloud" | "local" | "manual" | "auto";

export interface AiBatch {
  id: number;
  status: "pending" | "processing" | "done" | "cancelled";
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
  suggestedTags: CategorizedTags;
  status: "pending" | "confirmed" | "rejected" | "modified";
  confirmedTags: CategorizedTags;
  /** 单条打标失败原因（v6：失败详情落库，前端展示） */
  lastError: string | null;
  createdAt: number;
}

export interface ModelStatus {
  tier: "light" | "standard";
  state: "not_installed" | "downloading" | "ready" | "error";
  /** 0..1（downloading 时） */
  progress: number;
  sizeMb: number;
  localPath: string | null;
}
