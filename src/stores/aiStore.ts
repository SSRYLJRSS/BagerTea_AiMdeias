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
import { useSettingsStore } from "@/stores/settingsStore";

interface AiState {
  batches: AiBatch[];
  currentBatchId: number | null;
  suggestions: AiSuggestion[];
  running: boolean;
  /** 取消已受理、当前请求尚未结束（P2-01：诚实告知用户取消语义） */
  cancelling: boolean;
  error: string | null;
  /** 素材库「打标」带过来的选中素材与目标模式（跨页传递）；auto = 建批时按激活档案 kind 解析云端/本地（P3-01a） */
  pendingAssetIds: number[];
  pendingMode: "auto" | "manual";
  setPendingAssets: (ids: number[], mode: "auto" | "manual") => void;
  refreshBatches: () => Promise<void>;
  openBatch: (batchId: number) => Promise<void>;
  /** 只建批次不调 AI（v2.10）：跳转后图片立即上胶片条；manual 模式建完即就绪 */
  createBatch: (mode: "auto" | "manual") => Promise<void>;
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
  cancelling: false,
  error: null,
  pendingAssetIds: [],
  pendingMode: "auto" as const,

  setPendingAssets: (ids, mode) => set({ pendingAssetIds: ids, pendingMode: mode }),

  createBatch: async (mode) => {
    const ids = get().pendingAssetIds;
    if (ids.length === 0) return;
    // P2-07：前端先按批量上限拦截并提示（后端 take 保留作兜底防线）
    const limit = useSettingsStore.getState().settings?.ai.batchLimit;
    const capNotice =
      limit != null && ids.length > limit
        ? `选中 ${ids.length} 张超过批量上限 ${limit}，仅前 ${limit} 张进入批次`
        : null;
    const submitIds = capNotice ? ids.slice(0, limit!) : ids;
    set({ pendingAssetIds: [], error: capNotice });
    try {
      const batch = await aiCreateBatch(submitIds, mode);
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
      // P2-01：命令返回 = 当前图片已完成、批次已收尾（cancelled/done），取消状态复位
      set({ running: false, cancelling: false });
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
      const list = await aiListSuggestions(batchId);
      // P1-02：写入前校验当前批次未变——快速 A→B 切换时，A 的慢响应不得覆盖 B 的内容
      if (get().currentBatchId !== batchId) return;
      set({ suggestions: list });
    } catch (e) {
      if (get().currentBatchId !== batchId) return;
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  createAndRun: async (mode) => {
    const ids = get().pendingAssetIds;
    if (ids.length === 0) {
      set({ error: "请先在素材库选中素材再发起打标" });
      return;
    }
    // P2-07：前端先按批量上限拦截并提示（后端 take 保留作兜底防线）
    const limit = useSettingsStore.getState().settings?.ai.batchLimit;
    const capNotice =
      limit != null && ids.length > limit
        ? `选中 ${ids.length} 张超过批量上限 ${limit}，仅前 ${limit} 张进入批次`
        : null;
    const submitIds = capNotice ? ids.slice(0, limit!) : ids;
    set({ running: true, error: capNotice });
    try {
      const batch = await aiCreateBatch(submitIds, mode);
      set({ pendingAssetIds: [], currentBatchId: batch.id });
      await aiStartBatch(batch.id); // 同步等跑完，进度走事件
      await Promise.all([get().refreshBatches(), get().openBatch(batch.id)]);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ running: false, cancelling: false });
    }
  },

  cancel: async () => {
    const id = get().currentBatchId;
    if (id == null) return;
    // P2-01：取消只对「执行中」批次有即时语义；标记 cancelling 让 UI 明示
    // 「已受理、当前图片完成后停止」——300s 超时不动（本地 CPU 慢速打标需要），
    // 请求级中断需换 async 客户端（单独立项）
    if (get().running) set({ cancelling: true });
    await aiCancelBatch(id);
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

  patchProgress: (processed) => {
    set((s) => ({
      batches: s.batches.map((b) => (b.id === s.currentBatchId ? { ...b, processed, status: "processing" } : b)),
    }));
    // 执行中实时回载建议（1s 节流）：否则中间大图一直显示旧的空标签，进度动了却看不到结果
    const now = Date.now();
    const batchId = get().currentBatchId;
    if (batchId != null && now - lastLiveReloadAt > 1000) {
      lastLiveReloadAt = now;
      void get().openBatch(batchId);
    }
  },
}));

/** 进度事件驱动的 suggestions 实时回载节流时间戳（模块级，跨 set 调用共享） */
let lastLiveReloadAt = 0;
