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
import { getSettings, resetAppData } from "@/api/settings";
import { rescanAssetMetadata } from "@/api/assets";
import type { Settings } from "@/types/settings";
import type { TagFacet } from "@/types/tag";

// ── mock 后端/API 层 ──
const assetMocks = vi.hoisted(() => ({
  rescanAssetMetadata: vi.fn(),
  rescanAssetPalette: vi.fn(),
  cancelMediaRefill: vi.fn(),
  getPaletteStatus: vi.fn(),
}));
const libraryMocks = vi.hoisted(() => ({
  refreshPaletteFields: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/stores/libraryStore", () => ({
  useLibraryStore: {
    getState: () => ({ refreshPaletteFields: libraryMocks.refreshPaletteFields, refresh: libraryMocks.refresh }),
  },
}));
vi.mock("@/api/settings", () => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn().mockResolvedValue(undefined),
  getDataDir: vi.fn().mockResolvedValue("D:/data"),
  openDataDir: vi.fn().mockResolvedValue(undefined),
  clearThumbnailCache: vi.fn().mockResolvedValue(undefined),
  resetAppData: vi.fn().mockResolvedValue({
    assetsDeleted: 0,
    tagsDeleted: 0,
    aiTasksDeleted: 0,
    connectionsDeleted: 0,
    preferencesReset: false,
    cacheFilesDeleted: 0,
  }),
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
  // FB5-04：aiListModels 已删除（模型发现走 discoverAiModels / connections）
}));
vi.mock("@/api/thumbnail", () => ({
  clearThumbnailCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/api/tags", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listAllTagFacets: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/api/assets", () => ({
  rescanAssetMetadata: assetMocks.rescanAssetMetadata,
  rescanAssetPalette: assetMocks.rescanAssetPalette,
  cancelMediaRefill: assetMocks.cancelMediaRefill,
  getPaletteStatus: assetMocks.getPaletteStatus,
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

/** Field 结构：label 文本 → p → label 列 div → Field 根 div（根下才是控件列）。 */
function fieldSwitch(label: string): Element {
  const fieldRoot = screen.getByText(label).parentElement!.parentElement!;
  return fieldRoot.querySelector('[role="switch"]')!;
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
  // 默认 API 行为（色板状态：259 候选全缺；回算成功 259 条并更新前 3 条）
  assetMocks.rescanAssetMetadata.mockResolvedValue({ total: 2, success: 2, failed: 0, skipped: 0 });
  assetMocks.rescanAssetPalette.mockResolvedValue({
    total: 259, success: 259, failed: 0, skipped: 0, updatedIds: [1, 2, 3],
  });
  assetMocks.cancelMediaRefill.mockResolvedValue(undefined);
  assetMocks.getPaletteStatus.mockResolvedValue({
    totalAssets: 259, eligible: 259, ready: 0, missing: 259, unavailable: 0,
  });
  libraryMocks.refreshPaletteFields.mockReset().mockResolvedValue(undefined);
});

/** 切到「通用外观」路由并等待色板状态行渲染（FB4-03 状态在进入该路由时读取） */
async function openGeneral() {
  render(<SettingsPage />);
  await waitFor(() => expect(screen.getByText("保存设置")).toBeInTheDocument());
  fireEvent.click(screen.getByText("通用外观"));
  await waitFor(() => expect(screen.getByText("素材框")).toBeInTheDocument());
}

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

  // FB2-08（FX-07）+ FB3-10 + FB4-03：色条设置区块（「入库网格显示」已隐藏——永久 disabled 的噪音控件不保留）
  it("色条区块：切「显示算法主色色条」Toggle 触发即时预览；总开关关闭后位置/样式行不渲染", async () => {
    useSettingsStore.setState({ settings: mkSettings(), loaded: true, loading: false, loadError: null });
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText("保存设置")).toBeInTheDocument());
    fireEvent.click(screen.getByText("通用外观"));
    await waitFor(() => expect(screen.getByText("素材框")).toBeInTheDocument());

    // 默认 colorStrip.enabled=true → 位置/样式行都在（入库网格显示已按真实能力隐藏）
    expect(screen.getByText("显示算法主色色条")).toBeInTheDocument();
    expect(screen.getByText("素材库卡片显示")).toBeInTheDocument();
    expect(screen.getByText("大图浏览显示")).toBeInTheDocument();
    expect(screen.queryByText("入库网格显示")).toBeNull();
    expect(screen.getByText("色条高度")).toBeInTheDocument();

    // 点击总开关 → draft 关闭 + pushPreview（commitAppearanceDebounced）被调用
    const previewSpy = vi.spyOn(useSettingsStore.getState(), "commitAppearanceDebounced");
    const master = fieldSwitch("显示算法主色色条");
    fireEvent.click(master);
    await waitFor(() => expect(previewSpy).toHaveBeenCalled());
    // 关闭后位置/样式行整体不渲染（条件渲染，不是 disabled）；状态行（色条数据）仍可见
    expect(screen.queryByText("素材库卡片显示")).toBeNull();
    expect(screen.queryByText("大图浏览显示")).toBeNull();
    expect(screen.queryByText("色条高度")).toBeNull();
    expect(screen.getByText("色条数据")).toBeInTheDocument();
    // 再打开恢复渲染
    fireEvent.click(fieldSwitch("显示算法主色色条"));
    await waitFor(() => expect(screen.getByText("素材库卡片显示")).toBeInTheDocument());
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

  it("「数据与缓存」分组可触发媒体元数据回填（只补缺失信息范围；FB3-11 新按钮名）", async () => {
    useSettingsStore.setState({ settings: mkSettings(), loaded: true, loading: false, loadError: null });
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText("保存设置")).toBeInTheDocument());

    fireEvent.click(screen.getByText("数据与缓存"));
    fireEvent.click(screen.getByRole("button", { name: "只补缺失信息" }));

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

describe("SettingsPage 色条状态与生成（FB4-03 §10.6）", () => {
  it("通用外观路由加载色板状态并显示（缺 259 时的真实文案）", async () => {
    useSettingsStore.setState({ settings: mkSettings(), loaded: true, loading: false, loadError: null });
    await openGeneral();
    expect(assetMocks.getPaletteStatus).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByText(/已生成 0 \/ 可生成 259；另有 0 项暂不可生成/)).toBeInTheDocument(),
    );
  });

  it("总开关关闭时状态行仍可见（位置/样式行隐藏）", async () => {
    const settings = mkSettings();
    settings.appearance.colorStrip.enabled = false;
    useSettingsStore.setState({ settings, loaded: true, loading: false, loadError: null });
    await openGeneral();
    expect(screen.getByText("色条数据")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/已生成 0 \/ 可生成 259/)).toBeInTheDocument());
    expect(screen.queryByText("素材库卡片显示")).toBeNull();
    expect(screen.queryByText("大图浏览显示")).toBeNull();
  });

  it("missing > 0 时按钮可用并显示缺失数量", async () => {
    useSettingsStore.setState({ settings: mkSettings(), loaded: true, loading: false, loadError: null });
    await openGeneral();
    const btn = await screen.findByRole("button", { name: /生成缺失色条（259）/ });
    expect(btn).toBeEnabled();
  });

  it("missing = 0 时不可重复执行（显示全部完成）", async () => {
    assetMocks.getPaletteStatus.mockResolvedValue({
      totalAssets: 259, eligible: 259, ready: 259, missing: 0, unavailable: 0,
    });
    useSettingsStore.setState({ settings: mkSettings(), loaded: true, loading: false, loadError: null });
    await openGeneral();
    await waitFor(() => expect(screen.getByText(/所有可生成素材均已完成/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /生成缺失色条/ })).toBeNull();
  });

  it("eligible = 0 时显示无可生成说明", async () => {
    assetMocks.getPaletteStatus.mockResolvedValue({
      totalAssets: 0, eligible: 0, ready: 0, missing: 0, unavailable: 0,
    });
    useSettingsStore.setState({ settings: mkSettings(), loaded: true, loading: false, loadError: null });
    await openGeneral();
    await waitFor(() =>
      expect(screen.getByText("当前没有可生成色条的图片或视频封面")).toBeInTheDocument(),
    );
  });

  it("点击后调用 rescanAssetPalette([], \"missing\")；完成后刷新状态并定向同步 updatedIds", async () => {
    useSettingsStore.setState({ settings: mkSettings(), loaded: true, loading: false, loadError: null });
    await openGeneral();
    const btn = await screen.findByRole("button", { name: /生成缺失色条（259）/ });
    fireEvent.click(btn);
    await waitFor(() => expect(assetMocks.rescanAssetPalette).toHaveBeenCalledWith([], "missing"));
    await waitFor(() =>
      expect(screen.getByText(/生成完成：成功 259，跳过 0，失败 0（共处理 259）/)).toBeInTheDocument(),
    );
    // 完成后再读一次状态（初始 1 次 + 完成 1 次）
    expect(assetMocks.getPaletteStatus).toHaveBeenCalledTimes(2);
    // 只做定向同步，不调用全量 refresh（refreshPaletteFields 是唯一被使用的 libraryStore 方法）
    expect(libraryMocks.refreshPaletteFields).toHaveBeenCalledWith([1, 2, 3]);
  });

  it("手动流程不订阅或触发第二次全量 refresh（只调用 refreshPaletteFields）", async () => {
    useSettingsStore.setState({ settings: mkSettings(), loaded: true, loading: false, loadError: null });
    await openGeneral();
    fireEvent.click(await screen.findByRole("button", { name: /生成缺失色条（259）/ }));
    await waitFor(() => expect(libraryMocks.refreshPaletteFields).toHaveBeenCalledTimes(1));
    // 完成摘要成功显示（若误调了不存在的 refresh 会在错误分支留下痕迹）
    expect(screen.queryByText(/生成完成/)).toBeInTheDocument();
  });

  it("互斥闸占用/一般错误显示可读反馈，不轮询不自动重试", async () => {
    assetMocks.rescanAssetPalette.mockRejectedValue(new Error("已有回填任务进行中（媒体元数据回填或色板回算），请等待完成或先取消"));
    useSettingsStore.setState({ settings: mkSettings(), loaded: true, loading: false, loadError: null });
    await openGeneral();
    fireEvent.click(await screen.findByRole("button", { name: /生成缺失色条（259）/ }));
    await waitFor(() =>
      expect(screen.getByText(/已有回填任务进行中/)).toBeInTheDocument(),
    );
    expect(libraryMocks.refreshPaletteFields).not.toHaveBeenCalled();
  });

  it("状态读取失败显示可读错误与重试入口", async () => {
    assetMocks.getPaletteStatus.mockRejectedValue(new Error("数据库不可用"));
    useSettingsStore.setState({ settings: mkSettings(), loaded: true, loading: false, loadError: null });
    await openGeneral();
    await waitFor(() => expect(screen.getByText(/数据库不可用/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("回算成功但同步失败时保留摘要并显示具体错误", async () => {
    libraryMocks.refreshPaletteFields.mockRejectedValue(new Error("IPC 失败"));
    useSettingsStore.setState({ settings: mkSettings(), loaded: true, loading: false, loadError: null });
    await openGeneral();
    fireEvent.click(await screen.findByRole("button", { name: /生成缺失色条（259）/ }));
    await waitFor(() => expect(screen.getByText(/生成完成/)).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByText(/素材色条同步失败：IPC 失败/)).toBeInTheDocument(),
    );
  });
});
describe("数据与缓存 · 重置数据", () => {
  /** 切到「数据与缓存」路由并等待重置面板渲染 */
  async function openData() {
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText("保存设置")).toBeInTheDocument());
    fireEvent.click(screen.getByText("数据与缓存"));
    await waitFor(() => expect(screen.getByText("重置所选数据")).toBeInTheDocument());
  }

  it("未勾选时重置按钮禁用；两步确认后才调用 resetAppData，且传入勾选项", async () => {
    vi.mocked(resetAppData).mockResolvedValue({
      assetsDeleted: 259,
      tagsDeleted: 40,
      aiTasksDeleted: 3,
      connectionsDeleted: 0,
      preferencesReset: false,
      cacheFilesDeleted: 512,
    });
    useSettingsStore.setState({ settings: mkSettings(), loaded: true, loading: false, loadError: null });
    await openData();

    const btn = screen.getByRole("button", { name: "重置所选数据" });
    expect(btn).toBeDisabled();

    // 勾选素材 + 标签
    fireEvent.click(screen.getByText("素材库记录"));
    // 「标签与分类」同时出现在左侧导航与勾选项，取后者（面板内）
    fireEvent.click(screen.getAllByText("标签与分类").at(-1)!);
    expect(btn).toBeEnabled();

    // 第一步只出现确认文案，尚未调用后端
    fireEvent.click(btn);
    expect(screen.getByText(/此操作不可撤销/)).toBeInTheDocument();
    expect(resetAppData).not.toHaveBeenCalled();

    // 第二步确认 → 调用后端并携带勾选项；成功后展示报告并刷新素材库
    fireEvent.click(screen.getByRole("button", { name: "确认重置" }));
    await waitFor(() => expect(resetAppData).toHaveBeenCalledTimes(1));
    expect(resetAppData).toHaveBeenCalledWith({ ...{ assets: false, tags: false, aiTasks: false, aiConnections: false, preferences: false, caches: false }, assets: true, tags: true });
    await waitFor(() => expect(screen.getAllByText(/重置完成：已清除素材 259 条/).length).toBeGreaterThan(0));
    expect(libraryMocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("重置失败显示可读错误，不刷新素材库", async () => {
    vi.mocked(resetAppData).mockRejectedValue(new Error("正在执行回填任务，请等它结束或取消后再重置"));
    useSettingsStore.setState({ settings: mkSettings(), loaded: true, loading: false, loadError: null });
    await openData();

    fireEvent.click(screen.getByText("缓存文件"));
    fireEvent.click(screen.getByRole("button", { name: "重置所选数据" }));
    fireEvent.click(screen.getByRole("button", { name: "确认重置" }));
    await waitFor(() => expect(screen.getAllByText(/请等它结束或取消后再重置/).length).toBeGreaterThan(0));
    expect(libraryMocks.refresh).not.toHaveBeenCalled();
  });
});

describe("标签与分类 · 无配置条目分面的 AI 行为（回归：勾选被静默丢弃）", () => {
  const activeFacet: TagFacet = {
    key: "purpose",
    displayName: "用途",
    description: "",
    selectionMode: "multi",
    maxItems: 3,
    sortOrder: 1,
    isSystem: true,
    status: "active",
    appliesTo: "all",
    createdAt: 1,
    updatedAt: 1,
  };

  async function openTagsRoute() {
    useSettingsStore.setState({ settings: mkSettings(), loaded: true, loading: false, loadError: null });
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText("保存设置")).toBeInTheDocument());
    fireEvent.click(screen.getAllByText("标签与分类").at(-1)!);
    fireEvent.click(await screen.findByText("用途"));
  }

  it("无条目分面的「参与 AI」如实显示为关；勾选后补建条目并点亮「保存设置」", async () => {
    const { listAllTagFacets } = await import("@/api/tags");
    vi.mocked(listAllTagFacets).mockResolvedValue([activeFacet]);
    await openTagsRoute();

    // 无条目 = AI 本就不产出该分面（build_prompt_context 只遍历 aiFacetConfigs），如实显示为关
    const checkbox = await screen.findByRole("checkbox", { name: /参与 AI 打标与搜索/ });
    expect(checkbox).not.toBeChecked();

    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    // 草稿变脏 → 之前 bug 下这里保持禁用，用户以为「无法保存」
    expect(screen.getByRole("button", { name: "保存设置" })).toBeEnabled();
  });

  it("无条目分面输入「给 AI 的识别规则」也会补建条目（不再静默丢弃）", async () => {
    const { listAllTagFacets } = await import("@/api/tags");
    vi.mocked(listAllTagFacets).mockResolvedValue([activeFacet]);
    await openTagsRoute();

    fireEvent.change(await screen.findByLabelText("给 AI 的识别规则"), { target: { value: "只写稳定用途" } });
    expect(screen.getByRole("button", { name: "保存设置" })).toBeEnabled();
  });
});
