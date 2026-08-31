/** AI 打标命令封装（对应 commands/ai_cmd.rs，T05a） */
import { invoke, on } from "./client";
import type { AiBatch, AiMode, AiSuggestion, AiSuggestionItem, CategorizedTags } from "@/types/ai";
import type { UnlistenFn } from "@tauri-apps/api/event";

export interface AiProgress {
  batchId: number;
  processed: number;
  total: number;
  currentAssetId: number;
}

export function aiCreateBatch(assetIds: number[], mode: AiMode): Promise<AiBatch> {
  return invoke<AiBatch>("ai_create_batch", { assetIds, mode });
}

export function aiStartBatch(batchId: number, limit?: number): Promise<AiBatch> {
  return invoke<AiBatch>("ai_start_batch", { batchId, limit: limit ?? null });
}

export function aiCancelBatch(batchId: number): Promise<void> {
  return invoke<void>("ai_cancel_batch", { batchId });
}

export function aiListBatches(): Promise<AiBatch[]> {
  return invoke<AiBatch[]>("ai_list_batches");
}

export function aiListSuggestions(batchId: number): Promise<AiSuggestion[]> {
  return invoke<AiSuggestion[]>("ai_list_suggestions", { batchId });
}

export function aiListSuggestionItems(suggestionId: number): Promise<AiSuggestionItem[]> {
  return invoke<AiSuggestionItem[]>("ai_list_suggestion_items", { suggestionId });
}

export function aiDecideSuggestionItem(
  itemId: number,
  decision: "accepted" | "modified" | "rejected",
  replacementTagId?: number | null,
  replacementName?: string | null,
  reason?: string | null,
): Promise<void> {
  return invoke<void>("ai_decide_suggestion_item", {
    itemId,
    decision,
    replacementTagId: replacementTagId ?? null,
    replacementName: replacementName ?? null,
    reason: reason ?? null,
  });
}

/** FB5-05（§7.6）：确认单条建议。description = 审核后的最终描述（同一事务写入素材；空串不覆盖已有描述）。 */
export function aiConfirmSuggestion(
  id: number,
  tags: CategorizedTags,
  description?: string | null,
): Promise<void> {
  return invoke<void>("ai_confirm_suggestion", {
    id,
    tags,
    description: description ?? null,
  });
}

/** 批量套用标签到任意素材（胶片条多选套用） */
export function aiApplyTags(assetIds: number[], tags: CategorizedTags): Promise<void> {
  return invoke<void>("ai_apply_tags", { assetIds, tags });
}

export function aiRejectSuggestion(id: number): Promise<void> {
  return invoke<void>("ai_reject_suggestion", { id });
}

/** 撤销拒绝（v2.11）：恢复为待确认 */
export function aiRestoreSuggestion(id: number): Promise<void> {
  return invoke<void>("ai_restore_suggestion", { id });
}

export function aiConfirmAll(batchId: number): Promise<void> {
  return invoke<void>("ai_confirm_all", { batchId });
}

export function onAiProgress(handler: (p: AiProgress) => void): Promise<UnlistenFn> {
  return on<AiProgress>("ai://progress", handler);
}
