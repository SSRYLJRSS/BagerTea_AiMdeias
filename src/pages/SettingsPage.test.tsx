/**
 * SettingsPage 回归测试（指导书 §6.1/§12.5）：
 *  - 第一项是「入库与总库」；分组顺序为 入库与总库 → AI 设置 → 标签与分类 → 通用外观 → 数据与缓存 → 关于；
 *  - AI 设置内部可切换「超级搜索 AI / 打标 AI」子页，右侧显示在线/本地二选一；
 *  - 网盘分组与「本地打标」顶层组不存在（§6.8 网盘移除）；
 *  - 加载失败后点击重试会再次调用 load，成功后进入表单。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import SettingsPage from "@/pages/SettingsPage";
import { useSettingsStore } from "@/stores/settingsStore";
import { getSettings } from "@/api/settings";
import { rescanAssetMetadata } from "@/api/assets";
import type { Settings } from "@/types/settings";

// ── mock 后端/API 层 ──
vi.mock("@/api/settings", () => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn().mockResolvedValue(undefined),
  getDataDir: vi.fn().mockResolvedValue("D:/data"),
  openDataDir: vi.fn().mockResolvedValue(undefined),
  clearThumbnailCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/api/ollama", () => ({
  ollamaInstallStatus: vi.fn().mockResolvedValue({ installerPath: null, installerSize: 0 }),
  ollamaRemoveInstaller: vi.fn().mockResolvedValue(undefined),
  ollamaListSources: vi.fn().mockResolvedValue([{ id: "auto", label: "自动", url: "" }]),
  ollamaProbeSources: vi.fn().mockResolvedValue([{ id: "auto", label: "自动", ok: true, speedBps: 0 }]),
  ollamaAddCustomSource: vi.fn().mockResolvedValue(undefined),
  ollamaRemoveCustomSource: vi.fn().mockResolvedValue(undefined),
  ollamaListLocalModels: vi.fn().mockResolvedValue([]),
  ollamaDeleteModel: vi.fn().mockResolvedValue(undefined),
  ollamaModelDir: vi.fn().mockResolvedValue(""),
  ollamaOpenModelDir: vi.fn().mockResolvedValue(undefined),
  ollamaStartService: vi.fn().mockResolvedValue(undefined),
  probeOllamaHardware: vi.fn().mockResolvedValue({ available: false }),
  onOllamaInstallLog: vi.fn().mockRejectedValue(new Error("no tauri")),
  onOllamaInstallProgress: vi.fn().mockRejectedValue(new Error("no tauri")),
  onOllamaPullProgress: vi.fn().mockRejectedValue(new Error("no tauri")),
  pullOllamaModel: vi.fn().mockResolvedValue(undefined),
  ollamaPing: vi.fn().mockResolvedValue({ ok: false }),
}));
vi.mock("@/api/ai", () => ({
  aiListModels: vi.fn().mockResolvedValue(["qwen-vl-plus"]),
}));
vi.mock("@/api/thumbnail", () => ({
  clearThumbnailCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/api/assets", () => ({
  rescanAssetMetadata: vi.fn().mockResolvedValue({ total: 2, success: 2, failed: 0, skipped: 0 }),
  cancelMediaRefill: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/api/video", () => ({
  videoProxyCacheStats: vi.fn().mockResolvedValue([2, 1024 * 1024]),
  clearAllVideoProxies: vi.fn().mockResolvedValue(2),
}));
vi.mock("@/api/client", () => ({
  on: vi.fn().mockResolvedValue(() => undefined),
  invoke: vi.fn(),
  AppError: class extends Error {},
}));
vi.mock("@/api/connections", () => ({
  listAiConnections: vi.fn().mockResolvedValue([
    { id: "c1", name: "通义", deployment: "cloud", protocol: "openai_chat", baseUrl: "https://a/v1", model: "qwen-max", hasKey: true, enabled: true },
  ]),
  getAiUsageBindings: vi.fn().mockResolvedValue({ super_search: null, tagging: "c1" }),
  setAiUsageBinding: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));

/** 一份完整、可渲染的 Settings（normalizeSettings 之后的结构）。 */
function mkSettings(over: Partial<Settings> = {}): Settings {
  return {
    ai: {
      profiles: [{ id: "p1", name: "配置 1", apiMode: "openai", kind: "cloud", baseUrl: "", apiKey: "", model: "qwen-vl-plus" }],
      activeProfile: "p1",
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
    ...over,
  };
}

const emptyStore = {
  settings: null,
  loaded: false,
  loading: false,
  loadError: null,
  saving: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState(emptyStore);
  // 默认：getSettings 成功返回一份完整设置
  vi.mocked(getSettings).mockResolvedValue(mkSettings());
});

describe("SettingsPage §6.1 信息架构", () => {
  it("分组顺序：第一项是入库与总库；含 AI 设置/标签与分类/通用外观/数据与缓存/关于", async () => {
    useSettingsStore.setState({ settings: null, loaded: false, loading: false, loadError: null });
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText("保存设置")).toBeInTheDocument());

    for (const g of ["入库与总库", "AI 设置", "标签与分类", "通用外观", "数据与缓存", "关于"]) {
      expect(screen.getAllByText(g).length).toBeGreaterThan(0);
    }
  });

  it("网盘分组与「本地打标」顶层组不存在（§6.8 网盘移除）", async () => {
    useSettingsStore.setState({ settings: mkSettings(), loaded: true, loading: false, loadError: null });
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText("保存设置")).toBeInTheDocument());

    expect(screen.queryByText(/网盘/)).not.toBeInTheDocument();
    expect(screen.queryByText("本地打标")).not.toBeInTheDocument();
  });

  it("点击「AI 设置」显示三个子页「超级搜索 / 自动打标 / 服务管理」，默认路由为入库与总库", async () => {
    useSettingsStore.setState({ settings: mkSettings(), loaded: true, loading: false, loadError: null });
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText(/总库位置/)).toBeInTheDocument()); // 默认第一项

    fireEvent.click(screen.getByText("AI 设置"));
    // 「超级搜索」同时出现在左侧子页与右侧面板标题，用 getAllByText 断言至少出现
    await waitFor(() => expect(screen.getAllByText("超级搜索").length).toBeGreaterThan(0));
    expect(screen.getAllByText("自动打标").length).toBeGreaterThan(0);
    expect(screen.getByText("服务管理")).toBeInTheDocument();
  });

  it("FB2-02 素材框：切到「通用外观」后存在「素材框」组与 7 项比例选项", async () => {
    useSettingsStore.setState({ settings: mkSettings(), loaded: true, loading: false, loadError: null });
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText("保存设置")).toBeInTheDocument());
    fireEvent.click(screen.getByText("通用外观"));
    await waitFor(() => expect(screen.getByText("素材框")).toBeInTheDocument());
    // 7 项比例选项（1:1 / 4:3 / 3:2 / 16:9 / 3:4 / 2:3 / 9:16）
    const ratioOpts = Array.from(screen.getAllByRole("option") as HTMLOptionElement[]).map((o) => o.value).filter((v) => v.includes(":"));
    expect(ratioOpts.length).toBe(7);
    // 填充方式 3 项
    expect(
      Array.from(screen.getAllByRole("option") as HTMLOptionElement[]).filter((o) => ["cover", "contain", "smart"].includes(o.value)).length,
    ).toBe(3);
  });

  it("AI 子页「自动打标」只显示「此功能使用的服务」+ 功能参数，不再重复服务管理列表", async () => {
    useSettingsStore.setState({ settings: mkSettings(), loaded: true, loading: false, loadError: null });
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText("保存设置")).toBeInTheDocument());

    fireEvent.click(screen.getByText("AI 设置"));
    fireEvent.click(screen.getAllByText("自动打标")[0]);
    await waitFor(() => expect(screen.getByText("此功能使用的服务")).toBeInTheDocument());
    // 旧「部署方式」单选已移除（服务位置移到服务管理页）
    expect(screen.queryByText("部署方式")).not.toBeInTheDocument();
    // 不重复渲染服务管理列表（「+ 新增服务」不在用途页出现）
    expect(screen.queryByRole("button", { name: "+ 新增服务" })).not.toBeInTheDocument();
  });

  it("「服务管理」子页是唯一维护入口：服务位置二选一 + 服务列表", async () => {
    useSettingsStore.setState({ settings: mkSettings(), loaded: true, loading: false, loadError: null });
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText("保存设置")).toBeInTheDocument());

    fireEvent.click(screen.getByText("AI 设置"));
    fireEvent.click(screen.getByText("服务管理"));
    await waitFor(() => expect(screen.getAllByText("服务位置").length).toBeGreaterThan(0));
    expect(screen.getByRole("tab", { name: "在线服务" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "本机服务" })).toBeInTheDocument();
    // 服务管理页渲染连接列表（唯一入口）：列出 mock 的「通义」服务
    await waitFor(() => expect(screen.getAllByText("通义").length).toBeGreaterThan(0));
  });

  it("「服务管理」切到本机服务：显示本地说明与新增服务入口", async () => {
    useSettingsStore.setState({ settings: mkSettings(), loaded: true, loading: false, loadError: null });
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText("保存设置")).toBeInTheDocument());

    fireEvent.click(screen.getByText("AI 设置"));
    fireEvent.click(screen.getByText("服务管理"));
    await waitFor(() => expect(screen.getByRole("tab", { name: "本机服务" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: "本机服务" }));
    await waitFor(() => expect(screen.getByText(/仅在本机处理/)).toBeInTheDocument());
  });
});

describe("SettingsPage 加载与 Hook 安全", () => {
  it("settings 初始为空 → 加载成功后渲染表单，不抛 Hook 顺序错误", async () => {
    useSettingsStore.setState({ settings: null, loaded: false, loading: false, loadError: null });
    render(<SettingsPage />);

    expect(screen.getByText(/加载设置中/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("保存设置")).toBeInTheDocument());
  });

  it("加载失败显示错误，点击重试再次调用 load，成功后进入表单", async () => {
    vi.mocked(getSettings)
      .mockRejectedValueOnce(new Error("后端未连接"))
      .mockResolvedValueOnce(mkSettings());
    useSettingsStore.setState({ settings: null, loaded: false, loading: false, loadError: null });

    render(<SettingsPage />);

    await waitFor(() => expect(screen.getByText(/设置加载失败：后端未连接/)).toBeInTheDocument());
    expect(useSettingsStore.getState().loadError).toBe("后端未连接");

    fireEvent.click(screen.getByRole("button", { name: /重试/ }));
    await waitFor(() => expect(screen.getByText("保存设置")).toBeInTheDocument());
    expect(vi.mocked(getSettings)).toHaveBeenCalledTimes(2);
    expect(useSettingsStore.getState().settings).not.toBeNull();
  });

  it("「数据与缓存」分组可触发媒体元数据回填（仅缺字段范围）", async () => {
    useSettingsStore.setState({ settings: mkSettings(), loaded: true, loading: false, loadError: null });
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText("保存设置")).toBeInTheDocument());

    fireEvent.click(screen.getByText("数据与缓存"));
    fireEvent.click(screen.getByRole("button", { name: "仅缺字段" }));

    await waitFor(() => expect(rescanAssetMetadata).toHaveBeenCalledWith([], "missing"));
    await waitFor(() => expect(screen.getByText(/回填完成：总数 2，成功 2/)).toBeInTheDocument());
  });
});

describe("SettingsPage §13（FB-07）宽屏布局", () => {
  it("右侧内容不再用 max-w-xl 小框：存在 1040px 内容容器与加宽侧栏", async () => {
    useSettingsStore.setState({ settings: mkSettings(), loaded: true, loading: false, loadError: null });
    const { container } = render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText("保存设置")).toBeInTheDocument());
    // 内容容器使用 max-w-[1040px]（替代旧 max-w-xl）
    expect(container.querySelector(".max-w-\\[1040px\\]")).not.toBeNull();
    // 侧栏宽度进入 220~260px 范围
    const aside = container.querySelector("aside");
    expect(aside).not.toBeNull();
    expect((aside as HTMLElement).className).toMatch(/w-\[224px\]/);
  });

  it("保存栏 sticky 底部并提供 未保存/已保存 状态", async () => {
    useSettingsStore.setState({ settings: mkSettings(), loaded: true, loading: false, loadError: null });
    const { container } = render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText("保存设置")).toBeInTheDocument());
    // sticky 保存栏
    expect(container.querySelector(".sticky.bottom-0")).not.toBeNull();
    // 未做任何修改：不显示「有未保存的更改」
    expect(screen.queryByText("有未保存的更改")).not.toBeInTheDocument();
  });
});