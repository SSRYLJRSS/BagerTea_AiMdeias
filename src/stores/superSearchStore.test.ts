import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSuperSearchStore } from "@/stores/superSearchStore";
import { listAssets, listAssetIds } from "@/api/assets";
import { useSelectionStore } from "@/stores/selectionStore";
import type { Asset } from "@/types/asset";
import type { QueryExpr } from "@/types/queryExpr";

vi.mock("@/api/assets", () => ({
  listAssets: vi.fn(),
  listAssetIds: vi.fn(),
}));
vi.mock("@/api/superSearch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/superSearch")>();
  return { ...actual, aiParseSearchQuery: vi.fn() };
});

const mkAsset = (id: number): Asset => ({
  id, filePath: `d:/p/a${id}.jpg`, fileName: `a${id}.jpg`, fileExt: "jpg",
  fileSize: 100, mimeType: "image/jpeg", width: 800, height: 600,
  durationMs: null, videoCodec: null, audioCodec: null, takenAt: null,
  createdAt: id, modifiedAt: id, hash: null, placeholderPath: null,
  hdThumbnailPath: null, camera: null, lens: null, iso: null, aperture: null,
  shutter: null, focal: null, tags: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  useSelectionStore.setState({ selected: new Set(), anchorIndex: null });
});

describe("superSearchStore", () => {
  it("默认全库、非回收站、入库时间降序", () => {
    const q = useSuperSearchStore.getState().query;
    expect(q.assetType).toBe("all");
    expect(q.untaggedOnly).toBe(false);
    expect(q.sortBy).toBe("created_at");
    expect(q.sortDir).toBe("desc");
    expect(q.metadataFilters).toEqual([]);
  });

  it("查询变化清空选中并刷新", async () => {
    vi.mocked(listAssets).mockResolvedValue({ items: [mkAsset(1)], total: 1, hasMore: false });
    useSelectionStore.setState({ selected: new Set([9]), anchorIndex: null });
    useSuperSearchStore.getState().setQuery({ assetType: "image" });
    expect(useSelectionStore.getState().selected.size).toBe(0);
    await vi.waitFor(() => expect(useSuperSearchStore.getState().items.length).toBe(1));
  });

  it("旧请求不覆盖新查询（代际）", async () => {
    let resolve!: (v: { items: Asset[]; total: number; hasMore: boolean }) => void;
    vi.mocked(listAssets).mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    // 第一次 refresh 挂起
    void useSuperSearchStore.getState().refresh();
    // 立刻改查询触发第二次 refresh（mock 立即返回）
    vi.mocked(listAssets).mockResolvedValueOnce({ items: [mkAsset(2)], total: 1, hasMore: false });
    useSuperSearchStore.getState().setQuery({ search: "x" });
    await vi.waitFor(() => expect(listAssets).toHaveBeenCalledTimes(2), { timeout: 1000 });
    await vi.waitFor(() => expect(useSuperSearchStore.getState().items[0]?.id).toBe(2));
    // 旧响应回来，不得覆盖
    resolve({ items: [mkAsset(1)], total: 1, hasMore: false });
    await Promise.resolve();
    expect(useSuperSearchStore.getState().items[0].id).toBe(2);
  });

  it("fetchAllIds 走 list_asset_ids", async () => {
    vi.mocked(listAssetIds).mockResolvedValue([1, 2, 3]);
    const ids = await useSuperSearchStore.getState().fetchAllIds();
    expect(ids).toEqual([1, 2, 3]);
  });

  it("clearQuery 恢复默认", () => {
    useSuperSearchStore.getState().setQuery({ assetType: "video", search: "海边" });
    useSuperSearchStore.getState().clearQuery();
    const q = useSuperSearchStore.getState().query;
    expect(q.assetType).toBe("all");
    expect(q.search).toBe("");
  });

  it("setExpr 同步 query 字段并清理旧表达式", () => {
    const expr: QueryExpr = { op: "leaf", cond: { type: "assetType", value: "video" } };
    useSuperSearchStore.getState().setExpr(expr);
    expect(useSuperSearchStore.getState().query.assetType).toBe("video");
    useSuperSearchStore.getState().setQuery({ search: "海边" });
    expect(useSuperSearchStore.getState().expr).toBeUndefined();
  });

  it("AI replace：使用后端返回的 expr 为唯一事实源，query 只同步排序", async () => {
    const { aiParseSearchQuery } = await import("@/api/superSearch");
    const expr: QueryExpr = { op: "leaf", cond: { type: "search", value: "海边" } };
    vi.mocked(aiParseSearchQuery).mockResolvedValue({
      intent: {
        groups: [
          { assetType: "all", concepts: [{ text: "海边", role: "scene", facetHint: "scene", confidence: 0.95 }], textTerms: [], metadata: [] },
        ],
        exclusions: [],
        sortBy: null,
        sortDir: null,
      },
      expr,
      sortBy: "created_at",
      sortDir: "desc",
      explanation: "按关键词搜索",
      warnings: [],
      parseStatus: "full",
      resolvedTags: [],
    });
    useSuperSearchStore.getState().setExpr({ op: "leaf", cond: { type: "assetType", value: "image" } });
    await useSuperSearchStore.getState().applyAiSearch("海边");
    const st = useSuperSearchStore.getState();
    expect(st.expr).toEqual(expr);
    expect(st.query.sortBy).toBe("created_at");
    // 扁平 query 不再从 expr 反推（AI 结果以 expr 为准）
    expect(st.query.search).toBe("");
  });

  it("AI append：与整棵现有 expr 以 AND 合并，resolvedTags 按 tagId 合并", async () => {
    const { aiParseSearchQuery } = await import("@/api/superSearch");
    const newExpr: QueryExpr = { op: "leaf", cond: { type: "tag", facetKey: "subject", tagIds: [2], mode: "any", includeDescendants: true } };
    vi.mocked(aiParseSearchQuery).mockResolvedValue({
      intent: { groups: [], exclusions: [], sortBy: null, sortDir: null },
      expr: newExpr,
      sortBy: "created_at",
      sortDir: "desc",
      explanation: "",
      warnings: [],
      parseStatus: "full",
      resolvedTags: [{ facetKey: "subject", text: "树", tagId: 2, path: "" }],
    });
    const base: QueryExpr = { op: "leaf", cond: { type: "tag", facetKey: "subject", tagIds: [1], mode: "any", includeDescendants: true } };
    useSuperSearchStore.getState().setExpr(base);
    useSuperSearchStore.setState({ resolvedTags: [{ facetKey: "subject", text: "建筑", tagId: 1, path: "" }] });
    await useSuperSearchStore.getState().applyAiSearch("树", "append");
    const st = useSuperSearchStore.getState();
    expect(st.expr).toEqual({ op: "and", children: [base, newExpr] });
    expect(st.resolvedTags.map((t) => t.tagId).sort()).toEqual([1, 2]);
  });

  it("AI 解析失败：只设 aiError，保留当前 expr/items，不触发 refresh", async () => {
    const { aiParseSearchQuery } = await import("@/api/superSearch");
    vi.mocked(listAssets).mockResolvedValue({ items: [mkAsset(1)], total: 1, hasMore: false });
    vi.mocked(aiParseSearchQuery).mockRejectedValue(new Error("模型未返回可解析的 JSON"));
    const base: QueryExpr = { op: "leaf", cond: { type: "tag", facetKey: "subject", tagIds: [1], mode: "any", includeDescendants: true } };
    useSuperSearchStore.getState().setExpr(base);
    useSuperSearchStore.setState({ resolvedTags: [{ facetKey: "subject", text: "建筑", tagId: 1, path: "" }] });
    const refreshSpy = vi.fn();
    useSuperSearchStore.setState({ refresh: refreshSpy });
    await useSuperSearchStore.getState().applyAiSearch("无法解析的句子");
    const st = useSuperSearchStore.getState();
    expect(st.aiError).toContain("模型未返回");
    expect(st.error).toBeNull();
    expect(st.expr).toEqual(base);
    expect(st.resolvedTags.length).toBe(1);
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("removeExprAtPath 只摘除对应节点", () => {
    const expr: QueryExpr = {
      op: "and",
      children: [
        { op: "leaf", cond: { type: "search", value: "海边" } },
        { op: "leaf", cond: { type: "tag", facetKey: "subject", tagIds: [1], mode: "any", includeDescendants: true } },
      ],
    };
    useSuperSearchStore.getState().setExpr(expr);
    useSuperSearchStore.setState({ resolvedTags: [{ facetKey: "subject", text: "建筑", tagId: 1, path: "" }] });
    useSuperSearchStore.getState().removeExprAtPath([1]);
    expect(useSuperSearchStore.getState().expr).toEqual({ op: "leaf", cond: { type: "search", value: "海边" } });
    // 已不再引用的名称映射被清理
    expect(useSuperSearchStore.getState().resolvedTags).toEqual([]);
  });

  it("clearConditions 同时清 expr 与扁平筛选", () => {
    useSuperSearchStore.getState().setQuery({ search: "海边" });
    useSuperSearchStore.getState().setExpr({ op: "leaf", cond: { type: "assetType", value: "video" } });
    useSuperSearchStore.getState().clearConditions();
    const st = useSuperSearchStore.getState();
    expect(st.expr).toBeUndefined();
    expect(st.query.search).toBe("");
    expect(st.query.assetType).toBe("all");
  });
});
