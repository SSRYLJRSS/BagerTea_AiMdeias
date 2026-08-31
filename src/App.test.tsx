/**
 * App 启动骨架 + Viewer BottomBar 互斥测试（指导书 §3.2/§7.3 方案 A）：
 *  - 设置未加载时显示 StartupSkeleton（不显示页面内容，不显示空白）；
 *  - 设置加载完成后渲染页面；
 *  - viewerOpen=true 时全局 BottomBar 隐藏（Viewer 自带胶片条，避免双重导航），TitleBar 保留。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import App from "@/App";
import { useSettingsStore } from "@/stores/settingsStore";
import { useLibraryStore } from "@/stores/libraryStore";
import type { Settings } from "@/types/settings";

function mkSettings(): Settings {
  return {
    ai: {
      profiles: [],
      activeProfile: "",
      autoTagging: false,
      videoTagging: false,
      videoTaggingMode: "cover",
      videoFrameCount: 3,
      localModelTier: "light",
      batchLimit: 500,
      ollamaSourceId: "auto",
    },
    theme: "system",
    thumbnailCacheMb: 2048,
    tagCategories: [],
    aiFacetConfigs: [],
    libraryRoot: "",
    trashRetentionDays: 30,
    customDownloadSources: [],
    modelDownloadProxy: "",
    appearance: {
      grid: { libraryCellStep: 3, importCellStep: 1, cellAspect: "1:1", cellFit: "cover", matchDominantColor: false },
      hoverPreview: { enabled: true, previewSeconds: 3, inLibraryGrid: true },
      colorStrip: { enabled: true, showInLibraryGrid: false, showInViewer: true, showInImportGrid: false, height: "normal", mode: "ratio", count: 6 },
    },
  };
}

// 与 LibraryPage 测试相同的 mock 集（页面渲染需要）
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
vi.mock("@/api/settings", () => ({
  getSettings: vi.fn().mockResolvedValue({
    ai: { profiles: [], activeProfile: "", autoTagging: false, videoTagging: false, localModelTier: "light", batchLimit: 500, ollamaSourceId: "auto" },
    theme: "system",
    thumbnailCacheMb: 2048,
    tagCategories: [],
    aiFacetConfigs: [],
    libraryRoot: "",
    trashRetentionDays: 30,
    customDownloadSources: [],
    modelDownloadProxy: "",
  }),
  saveSettings: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/api/import", () => ({
  onImportProgress: vi.fn().mockRejectedValue(new Error("no tauri")),
}));
vi.mock("@/api/export", () => ({
  onExportProgress: vi.fn().mockRejectedValue(new Error("no tauri")),
}));
vi.mock("@/api/ai", () => ({
  onAiProgress: vi.fn().mockRejectedValue(new Error("no tauri")),
}));
// FB4-03：@/api/client 的 on() 用于 App 级 palette://updated 订阅（测试里捕获 handler 手动触发）
const clientMocks = vi.hoisted(() => ({
  on: vi.fn(),
}));
vi.mock("@/api/client", () => ({
  on: clientMocks.on,
  invoke: vi.fn(),
}));

vi.stubGlobal("ResizeObserver", class {
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe() {
    this.cb([{ contentRect: { width: 800, height: 600 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
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

const emptySettingsStore = {
  settings: null,
  loaded: false,
  loading: false,
  loadError: null,
  saving: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState(emptySettingsStore);
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
    viewerOpen: false,
    gridScrollTops: {},
  });
  mocks.listAssets.mockResolvedValue({ items: [], total: 0, hasMore: false });
  mocks.listAssetIds.mockResolvedValue([]);
  mocks.listMetadataFacets.mockResolvedValue([]);
  mocks.getAssetUrls.mockResolvedValue([]);
  mocks.revealInFolder.mockResolvedValue(undefined);
  mocks.trashRestore.mockResolvedValue(undefined);
  mocks.getThumbnailUrl.mockResolvedValue("asset://hd.webp");
  mocks.toFileUrl.mockImplementation((p: string) => `asset://${p}`);
  // 默认：on() 不捕获（订阅失败路径由 useTauriEvent 兜底）
  clientMocks.on.mockReset().mockRejectedValue(new Error("no tauri"));
});

describe("App 启动骨架（§3.2）", () => {
  it("设置未加载时先显示 StartupSkeleton（TitleBar 仍在）", async () => {
    useSettingsStore.setState(emptySettingsStore); // loaded=false → skeleton
    render(<App />);
    expect(screen.getByText("正在准备素材库")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument(); // TitleBar 保留
  });
});

describe("App §7.3 方案 A（Viewer 打开隐藏 BottomBar）", () => {
  const loadedStore = {
    settings: mkSettings(),
    loaded: true,
    loading: false,
    loadError: null,
    saving: false,
  };

  it("viewerOpen=true：BottomBar 隐藏、TitleBar 保留", async () => {
    useSettingsStore.setState(loadedStore);
    useLibraryStore.setState({ viewerOpen: true });
    render(<App />);
    // BottomBar 的「素材库/入库/打标」导航不渲染
    expect(screen.queryByText("素材库")).not.toBeInTheDocument();
    expect(screen.queryByText("入库")).not.toBeInTheDocument();
    expect(screen.queryByText("打标")).not.toBeInTheDocument();
    // TitleBar 始终保留
    expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument();
  });

  it("viewerOpen=false：BottomBar 正常显示", async () => {
    useSettingsStore.setState(loadedStore);
    render(<App />);
    expect(screen.getByText("素材库")).toBeInTheDocument();
    expect(screen.getByText("入库")).toBeInTheDocument();
    expect(screen.getByText("打标")).toBeInTheDocument();
  });
});

describe("App palette://updated 全局监听（FB4-03 §6.5/§10.7）", () => {
  const loadedStore = {
    settings: mkSettings(),
    loaded: true,
    loading: false,
    loadError: null,
    saving: false,
  };

  it("收到导入色板事件后只调用 refreshPaletteFields(updatedIds)，不调用 refresh", async () => {
    useSettingsStore.setState(loadedStore);
    let handler: ((p: unknown) => void) | undefined;
    clientMocks.on.mockImplementation((_event: string, h: (p: unknown) => void) => {
      handler = h;
      return Promise.resolve(() => undefined);
    });
    render(<App />);
    // 订阅建立（"palette://updated" 事件被监听）
    await waitFor(() =>
      expect(clientMocks.on).toHaveBeenCalledWith("palette://updated", expect.any(Function)),
    );
    // 挂载 spy：当前 store 对象上的 refresh 与 refreshPaletteFields（事件触发时 getState() 返回同一对象）
    const st = useLibraryStore.getState();
    const refreshSpy = vi.spyOn(st, "refresh").mockResolvedValue(undefined);
    const fieldsSpy = vi.spyOn(st, "refreshPaletteFields").mockResolvedValue(undefined);
    // 触发事件（source 固定 import）
    handler!({
      source: "import",
      total: 3,
      success: 3,
      failed: 0,
      skipped: 0,
      updatedIds: [11, 22],
    });
    await waitFor(() => expect(fieldsSpy).toHaveBeenCalledWith([11, 22]));
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("订阅失败（非 Tauri 环境）不阻塞首屏渲染", async () => {
    useSettingsStore.setState(loadedStore);
    clientMocks.on.mockRejectedValue(new Error("no tauri"));
    render(<App />);
    // 首屏正常（TitleBar 设置按钮在），不抛错
    expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument();
  });
});