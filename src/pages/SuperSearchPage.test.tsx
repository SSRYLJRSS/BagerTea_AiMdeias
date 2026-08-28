import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import SuperSearchPage from "@/pages/SuperSearchPage";
import { useSuperSearchStore } from "@/stores/superSearchStore";
import { useSelectionStore } from "@/stores/selectionStore";

// 让 rAF 同步执行：滚动方向 hook 依赖它（jsdom 无真实 rAF 时钟）
vi.spyOn(global, "requestAnimationFrame").mockImplementation((cb) => {
  cb(0);
  return 0;
});
vi.spyOn(global, "cancelAnimationFrame").mockImplementation(() => {});

vi.mock("@/api/assets", () => ({
  listAssets: vi.fn().mockResolvedValue({ items: [], total: 0, hasMore: false }),
  listAssetIds: vi.fn().mockResolvedValue([]),
  getAssetUrls: vi.fn().mockResolvedValue([]),
  revealInFolder: vi.fn().mockResolvedValue(undefined),
  listMetadataFacets: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/api/superSearch", () => ({
  aiParseSearchQuery: vi.fn().mockResolvedValue({
    intent: {},
    query: { search: "", assetType: "all", untaggedOnly: false, facetFilters: [], excludeTagIds: [], missingFacetKeys: [], metadataFilters: [], sortBy: "created_at", sortDir: "desc" },
    explanation: "",
    warnings: [],
    resolvedTags: [],
  }),
  queryToFilter: vi.fn(),
  listSuperAssets: vi.fn().mockResolvedValue({ items: [], total: 0, hasMore: false }),
  listSuperAssetIds: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/api/thumbnail", () => ({
  getThumbnailUrl: vi.fn().mockResolvedValue("asset://thumb/hd.webp"),
  toFileUrl: (p: string) => `asset://${p}`,
}));
vi.mock("@/api/tags", () => ({
  listTags: vi.fn().mockResolvedValue([]),
  listTagFacets: vi.fn().mockResolvedValue([]),
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

beforeEach(() => {
  vi.clearAllMocks();
  useSelectionStore.setState({ selected: new Set(), anchorIndex: null });
  useSuperSearchStore.setState({
    query: { search: "", assetType: "all", untaggedOnly: false, facetFilters: [], excludeTagIds: [], missingFacetKeys: [], metadataFilters: [], sortBy: "created_at", sortDir: "desc" },
    items: [],
    total: 0,
    loading: false,
    error: null,
    aiInput: "",
    aiLoading: false,
    aiExplanation: null,
    warnings: [],
  });
});

describe("SuperSearchPage", () => {
  it("渲染标题与返回按钮", () => {
    render(<SuperSearchPage onBack={() => undefined} />);
    expect(screen.getByText("超级搜索")).toBeInTheDocument();
    expect(screen.getByText("← 返回")).toBeInTheDocument();
    expect(screen.getAllByRole("searchbox")).toHaveLength(1);
    expect(screen.getByRole("region", { name: "条件公式" })).toBeInTheDocument();
  });

  function scrollTo(top: number) {
    const el = screen.getByTestId("super-search-scroll") as HTMLElement;
    Object.defineProperty(el, "scrollTop", { configurable: true, value: top, writable: true });
    fireEvent.scroll(el);
  }

  it("FB-06：下滚收起详细条件，上滚恢复", () => {
    render(<SuperSearchPage onBack={() => undefined} />);
    expect(screen.getByRole("region", { name: "条件公式" })).toBeInTheDocument();
    // 下滚超过阈值 → 条件面板收起
    scrollTo(40);
    expect(screen.queryByRole("region", { name: "条件公式" })).not.toBeInTheDocument();
    // 上滚 → 恢复
    scrollTo(0);
    expect(screen.getByRole("region", { name: "条件公式" })).toBeInTheDocument();
  });

  it("FB-06：底部快速编辑条打开抽屉", () => {
    render(<SuperSearchPage onBack={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "快速编辑条件" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭快速编辑" }));
  });

  it("FB-06：focus 进入时强制展开（不隐藏焦点）", () => {
    render(<SuperSearchPage onBack={() => undefined} />);
    scrollTo(60); // 收起
    expect(screen.queryByRole("region", { name: "条件公式" })).not.toBeInTheDocument();
    fireEvent.focus(screen.getByRole("searchbox") as HTMLElement);
    expect(screen.getByRole("region", { name: "条件公式" })).toBeInTheDocument();
  });
});
