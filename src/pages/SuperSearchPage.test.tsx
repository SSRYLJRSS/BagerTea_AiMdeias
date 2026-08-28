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

  it("FB-06：下滚收起详细条件，上滚恢复（FB2-06 改为 grid-template-rows 折叠，面板常驻 DOM）", () => {
    render(<SuperSearchPage onBack={() => undefined} />);
    const panel = document.getElementById("super-search-filters") as HTMLElement;
    expect(panel).toBeInTheDocument();
    expect(panel.style.gridTemplateRows).toBe("1fr"); // 初始展开
    expect(panel.getAttribute("aria-hidden")).toBe("false");
    // 下滚超过阈值（scrollTop>=48 且累计>=24）→ 收起
    scrollTo(100);
    expect(panel.style.gridTemplateRows).toBe("0fr");
    expect(panel.getAttribute("aria-hidden")).toBe("true");
    // 上滚（回到顶部区 minScrollTop）→ 恢复展开
    scrollTo(0);
    expect(panel.style.gridTemplateRows).toBe("1fr");
    expect(panel.getAttribute("aria-hidden")).toBe("false");
  });

  it("FB2-06：顶部区（scrollTop < 48）恒为展开态", () => {
    render(<SuperSearchPage onBack={() => undefined} />);
    scrollTo(30); // 低于 minScrollTop，即使下滚也保持展开
    const panel = document.getElementById("super-search-filters") as HTMLElement;
    expect(panel.style.gridTemplateRows).toBe("1fr");
  });

  it("FB2-06：focus 搜索框强制展开、focus 结果卡片不展开", () => {
    render(<SuperSearchPage onBack={() => undefined} />);
    scrollTo(100); // 收起
    const panel = document.getElementById("super-search-filters") as HTMLElement;
    expect(panel.style.gridTemplateRows).toBe("0fr");
    // focus 搜索框（在 header data-filter-zone 内）→ 强制展开
    fireEvent.focus(screen.getByRole("searchbox") as HTMLElement);
    expect(panel.style.gridTemplateRows).toBe("1fr");
  });
});
