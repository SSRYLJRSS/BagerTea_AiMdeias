/**
 * libraryStore 测试：数据分页载入 + B09（筛选清选中）+ BUG-E（fetchAllIds 轻量参数）+ B09 removedInView
 * mock 掉 @/api/assets 的 invoke 封装，Zustand 直接实例化断言。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listAssets, listAssetIds } from "@/api/assets";
import { useLibraryStore } from "@/stores/libraryStore";
import { useSelectionStore } from "@/stores/selectionStore";
import type { Asset, AssetPage } from "@/types/asset";

vi.mock("@/api/assets", () => ({
  listAssets: vi.fn(),
  listAssetIds: vi.fn(),
}));

const mkAsset = (id: number, over: Partial<Asset> = {}): Asset => ({
  id,
  filePath: `d:/lib/a${id}.jpg`,
  fileName: `a${id}.jpg`,
  fileExt: "jpg",
  fileSize: 100,
  mimeType: "image/jpeg",
  width: 800,
  height: 600,
  durationMs: null,
  videoCodec: null,
  audioCodec: null,
  takenAt: null,
  createdAt: id,
  modifiedAt: id,
  hash: null,
  placeholderPath: null,
  hdThumbnailPath: null,
  camera: null,
  lens: null,
  iso: null,
  aperture: null,
  shutter: null,
  focal: null,
  tags: [],
  ...over,
});

const pageOf = (items: Asset[], total = items.length): AssetPage => ({
  items,
  total,
  hasMore: items.length < total,
});

beforeEach(() => {
  vi.clearAllMocks();
  useLibraryStore.setState({
    items: [],
    total: 0,
    loading: false,
    error: null,
    filter: {
      assetType: "all",
      untaggedOnly: false,
      tagId: null,
      search: "",
      sortBy: "created_at",
      sortDir: "desc",
      trashOnly: false,
    },
  });
  useSelectionStore.setState({ selected: new Set(), anchorIndex: null });
});

describe("libraryStore 数据装载", () => {
  it("refresh 拉取首页并写入 items/total", async () => {
    vi.mocked(listAssets).mockResolvedValue(pageOf([mkAsset(1), mkAsset(2)], 2));
    await useLibraryStore.getState().refresh();
    const s = useLibraryStore.getState();
    expect(s.items.map((a) => a.id)).toEqual([1, 2]);
    expect(s.total).toBe(2);
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
    expect(listAssets).toHaveBeenCalledTimes(1);
  });

  it("refresh 失败写入 error 不抛异常", async () => {
    vi.mocked(listAssets).mockRejectedValue(new Error("invoke failed"));
    await useLibraryStore.getState().refresh();
    const s = useLibraryStore.getState();
    expect(s.error).toContain("invoke failed");
    expect(s.loading).toBe(false);
  });

  it("loadMore 追加去重且不越过 total", async () => {
    vi.mocked(listAssets).mockResolvedValueOnce(pageOf([mkAsset(1)], 3));
    vi.mocked(listAssets).mockResolvedValueOnce(pageOf([mkAsset(2)], 3));
    const s = useLibraryStore.getState();
    await s.refresh();
    await s.loadMore();
    const cur = useLibraryStore.getState();
    expect(cur.items.map((a) => a.id)).toEqual([1, 2]);
    expect(cur.total).toBe(3);
  });

  it("B09 回归：setFilter 清空选中集（跨筛选不残留不可见 id）", async () => {
    vi.mocked(listAssets).mockResolvedValue(pageOf([mkAsset(1)], 1));
    const s = useLibraryStore.getState();
    await s.refresh();
    useSelectionStore.getState().toggle(1, 0, true);
    expect(useSelectionStore.getState().count()).toBe(1);

    await s.setFilter({ assetType: "video" });
    expect(useSelectionStore.getState().count()).toBe(0);
    expect(useLibraryStore.getState().filter.assetType).toBe("video");
  });

  it("BUG-E 回归：fetchAllIds 走 list_asset_ids 只取 id 数组（不拉完整对象/不带 limit）", async () => {
    vi.mocked(listAssetIds).mockResolvedValue([7, 8, 9]);
    const ids = await useLibraryStore.getState().fetchAllIds();
    expect(ids).toEqual([7, 8, 9]);
    expect(listAssetIds).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(listAssetIds).mock.calls[0][0];
    // 轻量契约：一次查询全 id、不依赖分页 limit 数值（供全选/反选）
    expect(arg.limit).toBeUndefined();
    expect(arg.offset).toBe(0);
    // 筛选条件必须透传
    expect(arg).toMatchObject({ assetType: "all", sortBy: "created_at" });
  });

  it("B09 removedInView：removeLocal 只减当前视图内实际移除数", async () => {
    vi.mocked(listAssets).mockResolvedValue(pageOf([mkAsset(1), mkAsset(2), mkAsset(3)], 3));
    const s = useLibraryStore.getState();
    await s.refresh();
    // 模拟「选中了视图外的 id 4（跨筛选残留）」——视图内只有 1 移除 1 条
    s.removeLocal([1, 4]);
    const cur = useLibraryStore.getState();
    expect(cur.items.map((a) => a.id)).toEqual([2, 3]);
    // total 只减 1（视图内移除），不会因视图外 id 多减
    expect(cur.total).toBe(2);
  });

  it("P1-01 竞态回归：旧 refresh 慢返回被丢弃（新筛选主导）", async () => {
    // ① 第一次 refresh 挂起（慢）
    let resolveSlow!: (v: AssetPage) => void;
    vi.mocked(listAssets).mockImplementationOnce(
      () => new Promise((res) => (resolveSlow = res)),
    );
    const s = useLibraryStore.getState();
    const slow = s.refresh();
    // ② 筛选变更 → 第二次 refresh（快，立即返回）
    vi.mocked(listAssets).mockResolvedValueOnce(pageOf([mkAsset(2)], 1));
    await s.setFilter({ search: "鱼" });
    expect(useLibraryStore.getState().items.map((a) => a.id)).toEqual([2]);
    // ③ 旧响应晚到 → 必须丢弃（不得覆盖 items/total）
    resolveSlow(pageOf([mkAsset(1)], 5));
    await slow;
    const cur = useLibraryStore.getState();
    expect(cur.items.map((a) => a.id)).toEqual([2]);
    expect(cur.total).toBe(1);
    expect(cur.loading).toBe(false);
  });

  it("P1-01 竞态回归：旧 loadMore 慢返回被丢弃（offset 错位防护）", async () => {
    // 首页 3 条
    vi.mocked(listAssets).mockResolvedValueOnce(pageOf([mkAsset(1)], 3));
    await useLibraryStore.getState().refresh();
    // ① loadMore 挂起（捕获旧 items 与旧 offset）
    let resolveMore!: (v: AssetPage) => void;
    vi.mocked(listAssets).mockImplementationOnce(
      () => new Promise((res) => (resolveMore = res)),
    );
    const more = useLibraryStore.getState().loadMore();
    // ② 期间 refresh（新查询）完成
    vi.mocked(listAssets).mockResolvedValueOnce(pageOf([mkAsset(2)], 10));
    await useLibraryStore.getState().refresh();
    expect(useLibraryStore.getState().items.map((a) => a.id)).toEqual([2]);
    // ③ 旧 loadMore 返回 → 丢弃（不得用旧 offset 追加、不得覆盖 total）
    resolveMore(pageOf([mkAsset(9)], 3));
    await more;
    const cur = useLibraryStore.getState();
    expect(cur.items.map((a) => a.id)).toEqual([2]);
    expect(cur.total).toBe(10);
  });

  it("P2-08 去重回归：refresh 响应含重复 id 时不产生重复 key", async () => {
    vi.mocked(listAssets).mockResolvedValue(pageOf([mkAsset(1), mkAsset(1), mkAsset(2)], 3));
    await useLibraryStore.getState().refresh();
    expect(useLibraryStore.getState().items.map((a) => a.id)).toEqual([1, 2]);
  });
});