import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import SuperSearchPage from "@/pages/SuperSearchPage";
import { useSuperSearchStore } from "@/stores/superSearchStore";
import { useSelectionStore } from "@/stores/selectionStore";
import { useSettingsStore, DEFAULT_APPEARANCE } from "@/stores/settingsStore";
import type { Asset } from "@/types/asset";

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
    intent: { groups: [], exclusions: [], sortBy: null, sortDir: null },
    expr: null,
    sortBy: "created_at",
    sortDir: "desc",
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

/** 结果卡片用的最小 Asset（色条测试需要 palette） */
const mkAsset = (id: number, palette?: Asset["palette"]): Asset =>
  ({
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
    createdAt: 1,
    modifiedAt: 1,
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
    palette,
  }) as Asset;

beforeEach(() => {
  vi.clearAllMocks();
  useSelectionStore.setState({ selected: new Set(), anchorIndex: null });
  useSettingsStore.setState({ settings: null, previewAppearance: null });
  useSuperSearchStore.setState({
    query: { search: "", assetType: "all", untaggedOnly: false, facetFilters: [], excludeTagIds: [], metadataFilters: [], sortBy: "created_at", sortDir: "desc" },
    expr: undefined,
    items: [],
    total: 0,
    loading: false,
    error: null,
    aiError: null,
    aiInput: "",
    aiLoading: false,
    aiExplanation: null,
    warnings: [],
  });
});

describe("SuperSearchPage", () => {
  it("FB6 需求五：无顶栏返回按钮和重复标题；搜索框上方唯一「超级搜索」标识", () => {
    render(<SuperSearchPage />);
    // 不存在顶栏返回按钮
    expect(screen.queryByText("← 返回")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /返回/ })).not.toBeInTheDocument();
    // 「超级搜索」标识存在且唯一（AiSearchBar 内的 h1，非输入框 placeholder）
    const titles = screen.getAllByText("超级搜索");
    expect(titles).toHaveLength(1);
    expect(titles[0].tagName).toBe("H1");
    const searchbox = screen.getByRole("searchbox");
    expect(searchbox.getAttribute("placeholder")).not.toContain("超级搜索");
    // 搜索框在标识下方（同一容器内 h1 位于 form 之前）
    expect(titles[0].compareDocumentPosition(searchbox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("region", { name: "条件公式" })).toBeInTheDocument();
    // 结果计数保留在摘要行
    expect(screen.getByText(/项/)).toBeInTheDocument();
  });

  function scrollTo(top: number) {
    const el = screen.getByTestId("super-search-scroll") as HTMLElement;
    Object.defineProperty(el, "scrollTop", { configurable: true, value: top, writable: true });
    fireEvent.scroll(el);
  }

  it("FB-06：下滚收起详细条件，上滚恢复（FB2-06 改为 grid-template-rows 折叠，面板常驻 DOM）", () => {
    render(<SuperSearchPage />);
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
    render(<SuperSearchPage />);
    scrollTo(30); // 低于 minScrollTop，即使下滚也保持展开
    const panel = document.getElementById("super-search-filters") as HTMLElement;
    expect(panel.style.gridTemplateRows).toBe("1fr");
  });

  it("FB2-06：focus 搜索框强制展开、focus 结果卡片不展开", () => {
    render(<SuperSearchPage />);
    scrollTo(100); // 收起
    const panel = document.getElementById("super-search-filters") as HTMLElement;
    expect(panel.style.gridTemplateRows).toBe("0fr");
    // focus 搜索框（在 header data-filter-zone 内）→ 强制展开
    fireEvent.focus(screen.getByRole("searchbox") as HTMLElement);
    expect(panel.style.gridTemplateRows).toBe("1fr");
  });

  // FB2-08（FX-09）：结果卡片的色条主色段可点，写入同色系条件
  it("点结果卡片主色段 → 写入 hue±15 / sat±25 条件；再点另一色系替换而非叠加", () => {
    useSettingsStore.setState({
      settings: { appearance: { ...DEFAULT_APPEARANCE, colorStrip: { ...DEFAULT_APPEARANCE.colorStrip, enabled: true, showInLibraryGrid: true } } } as never,
      previewAppearance: null,
    });
    useSuperSearchStore.setState({
      items: [mkAsset(1, [{ hex: "#1b6ad2", r: 27, g: 106, b: 210, ratio: 0.7 }])],
      total: 1,
    });
    render(<SuperSearchPage />);

    const dominant = screen.getByRole("button", { name: /^搜索.+系素材$/ });
    fireEvent.click(dominant);
    const filters = useSuperSearchStore.getState().query.metadataFilters;
    expect(filters.map((f) => f.key)).toEqual(["dominant_hue", "dominant_sat"]);

    // 换一个色系：同 key 替换（叠加两个不相交 hue 区间会 AND 成空集）
    useSuperSearchStore.setState({
      items: [mkAsset(2, [{ hex: "#d21b1b", r: 210, g: 27, b: 27, ratio: 0.8 }])],
    });
    fireEvent.click(screen.getByRole("button", { name: /^搜索.+系素材$/ }));
    const next = useSuperSearchStore.getState().query.metadataFilters;
    expect(next.filter((f) => f.key === "dominant_hue")).toHaveLength(1);
  });

  describe("FB5-03 中央 Chevron 披露按钮（§3.5/§13.4）", () => {
    it("披露按钮位于中央独立行，只显示 Chevron 图标（无旧文字按钮）", () => {      render(<SuperSearchPage />);
      // 旧文字按钮不复存在
      expect(screen.queryByText(/展开详细条件 ⤵|收起 ⤴/)).not.toBeInTheDocument();
      // 中央披露按钮：仅图标（aria-label 驱动查询）
      expect(screen.getByRole("button", { name: "收起详细条件" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "展开详细条件" })).not.toBeInTheDocument();
      // 按钮位于 max-w-5xl 容器内的独立行（祖先含 mx-auto max-w-5xl）
      const btn = screen.getByRole("button", { name: "收起详细条件" });
      expect(btn.closest(".mx-auto.max-w-5xl")).not.toBeNull();
      // 行高 24px
      const row = btn.closest(".h-6") as HTMLElement;
      expect(row).not.toBeNull();
    });

    it("aria-expanded 与面板状态同步；点击切换 Chevron 方向", () => {
      render(<SuperSearchPage />);
      const btn = screen.getByRole("button", { name: "收起详细条件" });
      expect(btn.getAttribute("aria-expanded")).toBe("true");
      const panel = document.getElementById("super-search-filters") as HTMLElement;
      expect(panel.style.gridTemplateRows).toBe("1fr");

      fireEvent.click(btn);
      expect(screen.getByRole("button", { name: "展开详细条件" }).getAttribute("aria-expanded")).toBe("false");
      expect(panel.style.gridTemplateRows).toBe("0fr");
      expect(panel.getAttribute("aria-hidden")).toBe("true");

      fireEvent.click(screen.getByRole("button", { name: "展开详细条件" }));
      expect(screen.getByRole("button", { name: "收起详细条件" }).getAttribute("aria-expanded")).toBe("true");
      expect(panel.style.gridTemplateRows).toBe("1fr");
    });

    it("现有滚动收起/顶部展开/focus 展开逻辑全部保留", () => {
      render(<SuperSearchPage />);
      const panel = document.getElementById("super-search-filters") as HTMLElement;
      // 下滚收起
      scrollTo(100);
      expect(panel.style.gridTemplateRows).toBe("0fr");
      // focus 搜索框强制展开
      fireEvent.focus(screen.getByRole("searchbox") as HTMLElement);
      expect(panel.style.gridTemplateRows).toBe("1fr");
      // 上滚回顶部保持展开
      scrollTo(0);
      expect(panel.style.gridTemplateRows).toBe("1fr");
    });
  });
});
