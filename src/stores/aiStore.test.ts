/**
 * aiStore 测试：打标状态机核心迁移（v2.10/v2.12）
 * - createBatch 手动模式：建批即 done、无网络请求、建议载入
 * - createAndRun 空选中：报错不空跑
 * - confirm/reject 后重载建议（openBatch）
 * mock 掉 @/api/ai 的 invoke 封装。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  aiCancelBatch,
  aiConfirmAll,
  aiConfirmSuggestion,
  aiCreateBatch,
  aiListSuggestions,
  aiRejectSuggestion,
  aiRestoreSuggestion,
  aiStartBatch,
} from "@/api/ai";
import { useAiStore } from "@/stores/aiStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { AiBatch, AiSuggestion } from "@/types/ai";
import type { Settings } from "@/types/settings";

vi.mock("@/api/ai", () => ({
  aiCancelBatch: vi.fn(),
  aiConfirmAll: vi.fn(),
  aiConfirmSuggestion: vi.fn(),
  aiCreateBatch: vi.fn(),
  aiListSuggestions: vi.fn(),
  aiRejectSuggestion: vi.fn(),
  aiRestoreSuggestion: vi.fn(),
  aiStartBatch: vi.fn(),
}));

const mkBatch = (id: number, over: Partial<AiBatch> = {}): AiBatch => ({
  id,
  status: "pending",
  mode: "cloud",
  total: 1,
  processed: 0,
  confirmed: 0,
  createdAt: id,
  ...over,
});

const mkSuggestion = (id: number, over: Partial<AiSuggestion> = {}): AiSuggestion => ({
  id,
  batchId: 1,
  assetId: 100 + id,
  assetPath: `d:/lib/s${id}.jpg`,
  suggestedTags: {},
  status: "pending",
  confirmedTags: {},
  lastError: null,
  createdAt: id,
  ...over,
});

const IDs = [1, 2, 3];

/** 设置夹具：batchLimit 可覆盖 */
const mkSettings = (over: Partial<Settings["ai"]> = {}): Settings => ({
  ai: {
    profiles: [],
    activeProfile: "",
    autoTagging: false,
    videoTagging: false,
    localModelTier: "light",
    batchLimit: 500,
    ollamaSourceId: "auto",
    ...over,
  },
  theme: "system",
  thumbnailCacheMb: 2048,
  tagCategories: [],
  libraryRoot: "",
  trashRetentionDays: 30,
  customDownloadSources: [],
  modelDownloadProxy: "",
});

beforeEach(() => {
  vi.clearAllMocks();
  useAiStore.setState({
    batches: [],
    currentBatchId: null,
    suggestions: [],
    running: false,
    cancelling: false,
    error: null,
    pendingAssetIds: [],
    pendingMode: "auto",
  });
  useSettingsStore.setState({ settings: mkSettings(), loaded: true, loadError: null, saving: false });
});

describe("aiStore 打标状态机", () => {
  it("createBatch 手动模式：建批即 done（无网络请求）+ 建议载入 + 占位清空", async () => {
    vi.mocked(aiCreateBatch).mockResolvedValue(mkBatch(1, { status: "pending", mode: "manual" }));
    vi.mocked(aiStartBatch).mockResolvedValue(mkBatch(1, { status: "done", mode: "manual" }));
    vi.mocked(aiListSuggestions).mockResolvedValue([mkSuggestion(101), mkSuggestion(102)]);

    useAiStore.setState({ pendingAssetIds: IDs, pendingMode: "manual" });
    await useAiStore.getState().createBatch("manual");

    const s = useAiStore.getState();
    expect(s.currentBatchId).toBe(1);
    expect(s.pendingAssetIds).toEqual([]); // 带过去的选中清空
    expect(s.batches[0].status).toBe("done"); // 手动模式后端直接 done
    expect(s.suggestions).toHaveLength(2);
    expect(aiCreateBatch).toHaveBeenCalledWith(IDs, "manual");
  });

  it("createBatch 空选中：直接返回，不调后端", async () => {
    await useAiStore.getState().createBatch("auto");
    expect(aiCreateBatch).not.toHaveBeenCalled();
  });

  it("createAndRun 空选中：明确报错不空跑（v2.12 语义）", async () => {
    await useAiStore.getState().createAndRun("cloud");
    const s = useAiStore.getState();
    expect(s.error).toContain("选中素材");
    expect(aiCreateBatch).not.toHaveBeenCalled();
    expect(aiStartBatch).not.toHaveBeenCalled();
  });

  it("startBatch 云端：置 running、写回批次状态、重载建议", async () => {
    useAiStore.setState({ currentBatchId: 1, batches: [mkBatch(1)] });
    vi.mocked(aiStartBatch).mockResolvedValue(mkBatch(1, { status: "done", processed: 1 }));
    vi.mocked(aiListSuggestions).mockResolvedValue([mkSuggestion(101)]);

    await useAiStore.getState().startBatch();
    const s = useAiStore.getState();
    expect(s.running).toBe(false); // finally 复位
    expect(s.batches[0].status).toBe("done");
    expect(s.suggestions).toHaveLength(1);
    expect(aiStartBatch).toHaveBeenCalledWith(1, undefined);
  });

  it("confirm 成功：调后端后重载当前批次建议", async () => {
    useAiStore.setState({ currentBatchId: 1, suggestions: [mkSuggestion(101)] });
    vi.mocked(aiConfirmSuggestion).mockResolvedValue(undefined);
    vi.mocked(aiListSuggestions).mockResolvedValue([
      mkSuggestion(101, { status: "confirmed" }),
    ]);

    await useAiStore.getState().confirm(101, { 场景: ["公园"] });
    expect(aiConfirmSuggestion).toHaveBeenCalledWith(101, { 场景: ["公园"] });
    expect(useAiStore.getState().suggestions[0].status).toBe("confirmed");
  });

  it("reject → restore 恢复 pending（防误触 v2.11）", async () => {
    useAiStore.setState({ currentBatchId: 1, suggestions: [mkSuggestion(101)] });
    vi.mocked(aiRejectSuggestion).mockResolvedValue(undefined);
    vi.mocked(aiListSuggestions).mockResolvedValueOnce([
      mkSuggestion(101, { status: "rejected" }),
    ]);
    await useAiStore.getState().reject(101);
    expect(useAiStore.getState().suggestions[0].status).toBe("rejected");

    vi.mocked(aiRestoreSuggestion).mockResolvedValue(undefined);
    vi.mocked(aiListSuggestions).mockResolvedValueOnce([
      mkSuggestion(101, { status: "pending" }),
    ]);
    await useAiStore.getState().restore(101);
    expect(useAiStore.getState().suggestions[0].status).toBe("pending");
  });

  it("confirmAll 无当前批次：不调后端", async () => {
    await useAiStore.getState().confirmAll();
    expect(aiConfirmAll).not.toHaveBeenCalled();
  });

  it("patchProgress：实时写回 processing + 节流重载建议", async () => {
    useAiStore.setState({ currentBatchId: 1, batches: [mkBatch(1)] });
    vi.mocked(aiListSuggestions).mockResolvedValue([mkSuggestion(101)]);
    useAiStore.getState().patchProgress(3);
    const s = useAiStore.getState();
    expect(s.batches[0].processed).toBe(3);
    expect(s.batches[0].status).toBe("processing");
    // 首次 patch 应触发重载（>1s 节流窗口）
    expect(aiListSuggestions).toHaveBeenCalledTimes(1);
  });

  it("cancel：仅当有 currentBatchId 才调后端", async () => {
    useAiStore.setState({ currentBatchId: 1 });
    vi.mocked(aiCancelBatch).mockResolvedValue(undefined);
    await useAiStore.getState().cancel();
    expect(aiCancelBatch).toHaveBeenCalledWith(1);

    vi.clearAllMocks();
    useAiStore.setState({ currentBatchId: null });
    await useAiStore.getState().cancel();
    expect(aiCancelBatch).not.toHaveBeenCalled();
  });

  it("P1-02 竞态回归：快速切批次时旧批次慢响应不覆盖新批次", async () => {
    useAiStore.setState({ currentBatchId: 1 });
    // ① openBatch(1) 挂起（慢）
    let resolveA!: (v: AiSuggestion[]) => void;
    vi.mocked(aiListSuggestions).mockImplementationOnce(
      () => new Promise((res) => (resolveA = res)),
    );
    const openA = useAiStore.getState().openBatch(1);
    // ② 切到批次 2 并立即返回（快）
    vi.mocked(aiListSuggestions).mockResolvedValueOnce([mkSuggestion(201, { batchId: 2 })]);
    await useAiStore.getState().openBatch(2);
    expect(useAiStore.getState().suggestions.map((s) => s.id)).toEqual([201]);
    // ③ 批次 1 的慢响应晚到 → 丢弃
    resolveA([mkSuggestion(101, { batchId: 1 })]);
    await openA;
    expect(useAiStore.getState().suggestions.map((s) => s.id)).toEqual([201]);
  });

  it("P2-07 回归：超过批量上限时截断并明确提示", async () => {
    useSettingsStore.setState({ settings: mkSettings({ batchLimit: 2 }) });
    useAiStore.setState({ pendingAssetIds: [1, 2, 3, 4, 5], pendingMode: "auto" });
    vi.mocked(aiCreateBatch).mockResolvedValue(mkBatch(1));
    vi.mocked(aiListSuggestions).mockResolvedValue([]);

    await useAiStore.getState().createBatch("auto");

    // 只提交前 2 个 id，且用户看到截断提示
    expect(aiCreateBatch).toHaveBeenCalledWith([1, 2], "auto");
    expect(useAiStore.getState().error).toContain("超过批量上限 2");
  });

  it("P2-01 回归：运行中 cancel 标记 cancelling（当前图完成前 UI 明示）", async () => {
    useAiStore.setState({ currentBatchId: 1, running: true });
    vi.mocked(aiCancelBatch).mockResolvedValue(undefined);
    await useAiStore.getState().cancel();
    expect(useAiStore.getState().cancelling).toBe(true);
  });

  it("P2-01 回归：非运行中 cancel 不置 cancelling（避免状态卡死）", async () => {
    useAiStore.setState({ currentBatchId: 1, running: false });
    vi.mocked(aiCancelBatch).mockResolvedValue(undefined);
    await useAiStore.getState().cancel();
    expect(useAiStore.getState().cancelling).toBe(false);
  });
});