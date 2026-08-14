/** AI 打标（批次管理 + 确认流） */

export type AiMode = "cloud" | "local" | "manual";

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
