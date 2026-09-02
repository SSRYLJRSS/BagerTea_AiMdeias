/**
 * R0-5：AssetGridView 空结果态用「props 传入的筛选态」而非素材库 store。
 * 旧实现读 useLibraryStore.filter —— 超级搜索的条件不在那个 store 里，
 * 超搜 0 结果会误显示「素材库还是空的 / 去导入素材」，清除按钮也调错 store。
 * 本测试渲染受控组件直接验证：传 hasActiveFilter 优先于 store；onClearFilter 优先于 store 清空。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import AssetGridView from "@/components/library/AssetGridView";
import { useLibraryStore } from "@/stores/libraryStore";
import { useSelectionStore } from "@/stores/selectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { Asset } from "@/types/asset";

vi.mock("@/api/assets", () => ({
  listAssets: vi.fn().mockResolvedValue({ items: [], total: 0, hasMore: false }),
  listAssetIds: vi.fn().mockResolvedValue([]),
  getAssetUrls: vi.fn().mockResolvedValue([]),
  revealInFolder: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/api/thumbnail", () => ({
  getThumbnailUrl: vi.fn().mockResolvedValue("asset://thumb/hd.webp"),
  toFileUrl: (p: string) => `asset://${p}`,
}));

class MockResizeObserver {
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) { this.cb = cb; }
  observe() { this.cb([{ contentRect: { width: 800, height: 600 } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", MockResizeObserver);
vi.stubGlobal("IntersectionObserver", class {
  cb: IntersectionObserverCallback;
  constructor(cb: IntersectionObserverCallback) { this.cb = cb; }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
});
Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 800 });
Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, value: 600 });
Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 800 });
Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
  configurable: true,
  value: () => ({ width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }),
});

const baseProps = {
  items: [] as Asset[],
  total: 0,
  loading: false,
  loadMore: vi.fn(),
  fetchAllIds: vi.fn().mockResolvedValue([]),
  onPreview: vi.fn(),
  onAiTag: vi.fn(),
  onAssignTags: vi.fn(),
  onExport: vi.fn(),
  onMove: vi.fn(),
  onDelete: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  useSelectionStore.setState({ selected: new Set(), anchorIndex: null });
  useSettingsStore.setState({ settings: null, previewAppearance: null });
  // 素材库 store 保持「无筛选」：证明空态由 props 决定，不被 store 带偏
  useLibraryStore.setState({
    items: [],
    viewItems: [],
    total: 0,
    loading: false,
    error: null,
    filter: { assetType: "all", untaggedOnly: false, tagId: null, search: "", sortBy: "created_at", sortDir: "desc", trashOnly: false },
  });
});

describe("AssetGridView R0-5 空结果态", () => {
  it("素材库 store 无筛选 + props hasActiveFilter=true → 显示「没有符合条件的素材」而非「素材库还是空的」", () => {
    render(<AssetGridView {...baseProps} hasActiveFilter onClearFilter={vi.fn()} />);
    expect(screen.getByText("没有符合条件的素材")).toBeInTheDocument();
    expect(screen.queryByText("素材库还是空的")).not.toBeInTheDocument();
  });

  it("素材库 store 无筛选 + props hasActiveFilter=false → 显示「素材库还是空的」", () => {
    render(<AssetGridView {...baseProps} hasActiveFilter={false} onClearFilter={vi.fn()} />);
    expect(screen.getByText("素材库还是空的")).toBeInTheDocument();
    expect(screen.queryByText("没有符合条件的素材")).not.toBeInTheDocument();
  });

  it("点「清除筛选条件」调 props.onClearFilter（不碰素材库 store）", () => {
    const onClearFilter = vi.fn();
    render(<AssetGridView {...baseProps} hasActiveFilter onClearFilter={onClearFilter} />);
    fireEvent.click(screen.getByRole("button", { name: "清除筛选条件" }));
    expect(onClearFilter).toHaveBeenCalledTimes(1);
    // store 未被触碰：filter 仍是空筛选（props 路径不会去清素材库）
    expect(useLibraryStore.getState().filter.search).toBe("");
  });

  it("未传 props 时回退读素材库 store（素材库页行为不变）", () => {
    useLibraryStore.setState({
      filter: { assetType: "all", untaggedOnly: false, tagId: 7, search: "", sortBy: "created_at", sortDir: "desc", trashOnly: false },
    });
    render(<AssetGridView {...baseProps} />);
    expect(screen.getByText("没有符合条件的素材")).toBeInTheDocument();
  });
});
