/** AI 打标状态：批次列表 + 当前批次建议 + 从素材库带过来的待打标选择 */
import { create } from "zustand";
import {
  aiCancelBatch,
  aiConfirmAll,
  aiConfirmSuggestion,
  aiCreateBatch,
  aiListBatches,
  aiListSuggestions,
  aiRejectSuggestion,
  aiRestoreSuggestion,
  aiStartBatch,
} from "@/api/ai";
import type { AiBatch, AiSuggestion, CategorizedTags } from "@/types/ai";

interface AiState {
  batches: AiBatch[];
  currentBatchId: number | null;
  suggestions: AiSuggestion[];
  running: boolean;
  error: string | null;
  /** 素材库「打标」带过来的选中素材与目标模式（跨页传递） */
  pendingAssetIds: number[];
  pendingMode: "cloud" | "manual";
  setPendingAssets: (ids: number[], mode: "cloud" | "manual") => void;
  refreshBatches: () => Promise<void>;
  openBatch: (batchId: number) => Promise<void>;
  /** 只建批次不调 AI（v2.10）：跳转后图片立即上胶片条；manual 模式建完即就绪 */
  createBatch: (mode: "cloud" | "manual") => Promise<void>;
  /** 云端批次手动启动（左栏「开始打标」按钮） */
  startBatch: (limit?: number) => Promise<void>;
  /** 撤销拒绝（v2.11） */
  restore: (id: number) => Promise<void>;
  createAndRun: (mode: "cloud" | "local" | "manual") => Promise<void>;
  cancel: () => Promise<void>;
  confirm: (id: number, tags: CategorizedTags) => Promise<void>;
  reject: (id: number) => Promise<void>;
  confirmAll: () => Promise<void>;
  patchProgress: (processed: number) => void;
}

export const useAiStore = create<AiState>((set, get) => ({
  batches: [],
  currentBatchId: null,
  suggestions: [],
  running: false,
  error: null,
  pendingAssetIds: [],
  pendingMode: "cloud" as const,

  setPendingAssets: (ids, mode) => set({ pendingAssetIds: ids, pendingMode: mode }),

  createBatch: async (mode) => {
    const ids = get().pendingAssetIds;
    if (ids.length === 0) return;
    set({ pendingAssetIds: [], error: null });
    try {
      const batch = await aiCreateBatch(ids, mode);
      set((s) => ({ batches: [batch, ...s.batches], currentBatchId: batch.id }));
      if (mode === "manual") {
        // 手动模式：后端直接置 done，不调 AI；建议占位载入后即可人工编辑
        const done = await aiStartBatch(batch.id);
        set((s) => ({ batches: s.batches.map((b) => (b.id === done.id ? done : b)) }));
      }
      await get().openBatch(batch.id);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  startBatch: async (limit) => {
    const batchId = get().currentBatchId;
    if (!batchId) return;
    set({ running: true, error: null });
    try {
      const batch = await aiStartBatch(batchId, limit);
      set((s) => ({ batches: s.batches.map((b) => (b.id === batch.id ? batch : b)) }));
      await get().openBatch(batchId);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ running: false });
    }
  },

  refreshBatches: async () => {
    try {
      set({ batches: await aiListBatches() });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  openBatch: async (batchId) => {
    set({ currentBatchId: batchId });
    try {
      set({ suggestions: await aiListSuggestions(batchId) });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  createAndRun: async (mode) => {
    const ids = get().pendingAssetIds;
    if (ids.length === 0) {
      set({ error: "请先在素材库选中素材再发起打标" });
      return;
    }
    set({ running: true, error: null });
    try {
      const batch = await aiCreateBatch(ids, mode);
      set({ pendingAssetIds: [], currentBatchId: batch.id });
      await aiStartBatch(batch.id); // 同步等跑完，进度走事件
      await Promise.all([get().refreshBatches(), get().openBatch(batch.id)]);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ running: false });
    }
  },

  cancel: async () => {
    const id = get().currentBatchId;
    if (id != null) await aiCancelBatch(id);
  },

  confirm: async (id, tags) => {
    await aiConfirmSuggestion(id, tags);
    const batchId = get().currentBatchId;
    if (batchId != null) await get().openBatch(batchId);
  },

  reject: async (id) => {
    await aiRejectSuggestion(id);
    const batchId = get().currentBatchId;
    if (batchId != null) await get().openBatch(batchId);
  },

  restore: async (id) => {
    await aiRestoreSuggestion(id);
    const batchId = get().currentBatchId;
    if (batchId != null) await get().openBatch(batchId);
  },

  confirmAll: async () => {
    const batchId = get().currentBatchId;
    if (batchId == null) return;
    await aiConfirmAll(batchId);
    await Promise.all([get().refreshBatches(), get().openBatch(batchId)]);
  },

  patchProgress: (processed) =>
    set((s) => ({
      batches: s.batches.map((b) => (b.id === s.currentBatchId ? { ...b, processed, status: "processing" } : b)),
    })),
}));
