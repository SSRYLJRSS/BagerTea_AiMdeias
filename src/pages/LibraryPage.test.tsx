/**
 * LibraryPage 全页集成测试：真实组件链（SideBar + GridToolbar + AssetGrid + 弹窗组）
 * 单击卡片后观察选中态是否被其他组件意外清除（用户报告「单击自动取消选择」）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import LibraryPage from "@/pages/LibraryPage";
import { useLibraryStore } from "@/stores/libraryStore";
import { useSelectionStore } from "@/stores/selectionStore";
import type { Asset, AssetPage } from "@/types/asset";

// ── mock API 层 ──
const mocks = vi.hoisted(() => ({
  listAssets: vi.fn(),
  listAssetIds: vi.fn(),
  listMetadataFacets: vi.fn(),
  getAssetUrls: vi.fn(),
  revealInFolder: vi.fn(),
  trashRestore: vi.fn(),
  getThumbnailUrl: vi.fn(),
  toFileUrl: vi.fn(),
}));
vi.mock("@/api/assets", () => ({
  listAssets: mocks.listAssets,
  listAssetIds: mocks.listAssetIds,
  listMetadataFacets: mocks.listMetadataFacets,
  getAssetUrls: mocks.getAssetUrls,
  revealInFolder: mocks.revealInFolder,
  trashRestore: mocks.trashRestore,
}));
vi.mock("@/api/thumbnail", () => ({
  getThumbnailUrl: mocks.getThumbnailUrl,
  toFileUrl: mocks.toFileUrl,
}));
vi.mock("@/api/tags", () => ({
  removeTags: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/api/video", () => ({
  ensureVideoProxy: vi.fn(),
  cancelVideoProxy: vi.fn().mockResolvedValue(undefined),
  toProxyFileUrl: (p: string) => `asset://proxy/${p}`,
}));
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
}));

// ── jsdom 布局/观测器桩（虚拟滚动 + Thumbnail 依赖） ──
vi.stubGlobal("ResizeObserver", class {
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe() {
    this.cb(
      [{ contentRect: { width: 800, height: 600 } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
});
vi.stubGlobal("IntersectionObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
});
Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 800 });
Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, value: 600 });
Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 800 });
Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
  configurable: true,
  value: () => ({
    width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}),
  }),
});

const mkAsset = (id: number): Asset => ({
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
  placeholderPath: `thumb${id}.jpg`,
  hdThumbnailPath: null,
  camera: null,
  lens: null,
  iso: null,
  aperture: null,
  shutter: null,
  focal: null,
  tags: [],
});

const pageOf = (items: Asset[]): AssetPage => ({ items, total: items.length, hasMore: false });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listAssets.mockResolvedValue(pageOf([mkAsset(1), mkAsset(2), mkAsset(3)]));
  mocks.listAssetIds.mockResolvedValue([1, 2, 3]);
  mocks.listMetadataFacets.mockResolvedValue([]);
  mocks.getAssetUrls.mockResolvedValue([]);
  mocks.revealInFolder.mockResolvedValue(undefined);
  mocks.trashRestore.mockResolvedValue(undefined);
  mocks.getThumbnailUrl.mockResolvedValue("asset://hd.webp");
  mocks.toFileUrl.mockImplementation((p: string) => `asset://${p}`);
  useLibraryStore.setState({
    items: [],
    total: 0,
    loading: false,
    error: null,
    filter: {
      assetType: "all",
      untaggedOnly: false,
      tagId: null,
      facetFilters: [],
      excludeTagIds: [],
      metadataFilters: [],
      search: "",
      sortBy: "created_at",
      sortDir: "desc",
      trashOnly: false,
    },
  });
  useSelectionStore.setState({ selected: new Set(), anchorIndex: null });
  useLibraryStore.setState({ viewerOpen: false, gridScrollTops: {} });
});

describe("LibraryPage 全页（单击选中不被自动清除）", () => {
  it("单击卡片后选中态保持（等待超过双击保护窗口与防抖周期）", async () => {
    render(<LibraryPage />);
    // 等待 LibraryPage 挂载 effect 的 refresh 完成并渲染卡片
    await waitFor(() => expect(screen.getAllByAltText("a1.jpg").length).toBeGreaterThan(0));
    const card = screen.getAllByAltText("a1.jpg")[0].closest('[role="button"]') as HTMLElement;

    fireEvent.click(card);
    await waitFor(() => expect(useSelectionStore.getState().selected.has(1)).toBe(true));

    // 观察 1.2s：双击窗口(250ms) + 搜索防抖(300ms) + refresh 周期均远超
    await new Promise((r) => setTimeout(r, 1200));
    expect(useSelectionStore.getState().selected.has(1)).toBe(true);
    expect(card.getAttribute("aria-selected")).toBe("true");
  });

  it("选中后触发 loadMore/refresh 等数据刷新，选中不被清", async () => {
    render(<LibraryPage />);
    await waitFor(() => expect(screen.getAllByAltText("a2.jpg").length).toBeGreaterThan(0));
    const card = screen.getAllByAltText("a2.jpg")[0].closest('[role="button"]') as HTMLElement;
    fireEvent.click(card);
    await waitFor(() => expect(useSelectionStore.getState().selected.has(2)).toBe(true));

    // 模拟后端数据刷新（refresh 再次返回新数组）
    mocks.listAssets.mockResolvedValue(pageOf([mkAsset(2), mkAsset(3), mkAsset(4)]));
    await useLibraryStore.getState().refresh();
    await new Promise((r) => setTimeout(r, 500));
    expect(useSelectionStore.getState().selected.has(2)).toBe(true);
  });

  it("选中后点侧栏标签/类型筛选——按 B09 设计清选（确认行为符合预期而非幽灵取消）", async () => {
    render(<LibraryPage />);
    await waitFor(() => expect(screen.getAllByAltText("a1.jpg").length).toBeGreaterThan(0));
    const card = screen.getAllByAltText("a1.jpg")[0].closest('[role="button"]') as HTMLElement;
    fireEvent.click(card);
    await waitFor(() => expect(useSelectionStore.getState().selected.has(1)).toBe(true));

    // 切「视频」类型筛选 → B09：筛选变更清空选中（预期行为，非幽灵取消）
    fireEvent.click(screen.getByText("视频"));
    await waitFor(() => expect(useSelectionStore.getState().selected.size).toBe(0));
  });
});

describe("LibraryPage §7.2 Viewer 页面级替换（互斥）", () => {
  it("双击进入 Viewer：库页侧栏/工具栏卸载，Viewer 独占内容区", async () => {
    render(<LibraryPage />);
    await waitFor(() => expect(screen.getAllByAltText("a1.jpg").length).toBeGreaterThan(0));
    // 库页元素存在于渲染树
    expect(screen.getByText("回收站")).toBeInTheDocument();

    const card = screen.getAllByAltText("a1.jpg")[0].closest('[role="button"]') as HTMLElement;
    fireEvent.doubleClick(card);

    // Viewer 打开：库页筛选/侧栏/工具栏不在渲染树
    await waitFor(() => expect(screen.getByRole("button", { name: "返回素材库" })).toBeInTheDocument());
    expect(screen.queryByText("回收站")).not.toBeInTheDocument();
    expect(screen.queryByText("全部")).not.toBeInTheDocument();
    // Viewer 独占：网格卡片（aria-selected 标记）不再渲染；胶片条按钮无此标记
    expect(document.querySelectorAll("[aria-selected]")).toHaveLength(0);
    // viewerOpen 同步（App 据此隐藏 BottomBar）
    expect(useLibraryStore.getState().viewerOpen).toBe(true);
  });

  it("关闭 Viewer：库页上下文恢复（侧栏/网格回渲染）", async () => {
    render(<LibraryPage />);
    await waitFor(() => expect(screen.getAllByAltText("a1.jpg").length).toBeGreaterThan(0));
    const card = screen.getAllByAltText("a1.jpg")[0].closest('[role="button"]') as HTMLElement;
    fireEvent.doubleClick(card);
    await waitFor(() => expect(screen.getByRole("button", { name: "关闭查看器" })).toBeInTheDocument());
    expect(useLibraryStore.getState().viewerOpen).toBe(true);

    // 关闭 Viewer（Esc 或关闭按钮）
    fireEvent.click(screen.getByRole("button", { name: "关闭查看器" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "关闭查看器" })).not.toBeInTheDocument());
    expect(useLibraryStore.getState().viewerOpen).toBe(false);
    // 库页元素恢复
    expect(screen.getByText("回收站")).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByAltText("a1.jpg").length).toBeGreaterThan(0));
  });
});
