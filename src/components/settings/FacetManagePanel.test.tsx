/**
 * W4 FacetManagePanel 测试：两组列表 + 弹窗化编辑/新建/删除。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import FacetManagePanel from "@/components/settings/FacetManagePanel";
import { listAllTagFacets, createTagFacet, updateTagFacet, deleteTagFacet, getTagFacetImpact, restoreTagFacet, setFacetKind, convertFacetKind, type ConversionReport } from "@/api/tags";
import type { TagFacet } from "@/types/tag";
import type { Settings } from "@/types/settings";

vi.mock("@/api/tags", () => ({
  listAllTagFacets: vi.fn(),
  createTagFacet: vi.fn(),
  updateTagFacet: vi.fn().mockResolvedValue(undefined),
  reorderTagFacets: vi.fn().mockResolvedValue(undefined),
  deleteTagFacet: vi.fn().mockResolvedValue({ tagsDeleted: 2, unlinked: 3, opsDeleted: 0, itemsDeleted: 0 }),
  deactivateTagFacet: vi.fn().mockResolvedValue(undefined),
  restoreTagFacet: vi.fn().mockResolvedValue(undefined),
  getTagFacetImpact: vi.fn().mockResolvedValue({ tagCount: 2, assetCount: 3, aiSuggestionItemCount: 0, tagOpCount: 0 }),
  listContentDescriptions: vi.fn().mockResolvedValue([]),
  setFacetKind: vi.fn().mockResolvedValue(undefined),
  convertFacetKind: vi.fn().mockResolvedValue(undefined),
}));

/** 页面草稿（提示词编辑进 draft，由「保存设置」统一落库） */
const mkDraft = (over: Partial<Settings["ai"]> = {}): Settings => ({
  ai: {
    profiles: [],
    activeProfile: "",
    videoTagging: false,
    videoTaggingMode: "cover",
    videoFrameCount: 3,
    batchLimit: 500,
    systemPromptTagging: "",
    systemPromptSearch: "",
    ollamaSourceId: "auto",
    confidenceMinSuggest: 0.3,
    ...over,
  },
  theme: "system",
  logLevel: "info",
  thumbnailCacheMb: 2048,
  tagCategories: [],
  libraryRoot: "",
  trashRetentionDays: 30,
  customDownloadSources: [],
  modelDownloadProxy: "",
  appearance: {
    grid: { libraryCellStep: 3, importCellStep: 1, cellAspect: "1:1", cellFit: "cover", matchDominantColor: false },
    hoverPreview: { enabled: true, previewSeconds: 3, inLibraryGrid: true },
    colorStrip: { enabled: true, showInLibraryGrid: false, showInViewer: true, showInImportGrid: false, height: "normal", mode: "ratio", count: 6 },
    kinship: { syncTagsToSiblings: true, mergeInLibrary: false },
  },
});

const renderPanel = (over: Partial<Settings["ai"]> = {}) => {
  const draft = mkDraft(over);
  const onPatchAi = vi.fn((patch: Partial<Settings["ai"]>) => patch);
  const utils = render(<FacetManagePanel draft={draft} onPatchAi={onPatchAi} />);
  return { ...utils, draft, onPatchAi };
};

const facet = (over: Partial<TagFacet> = {}): TagFacet => ({
  key: "clothing_color",
  displayName: "衣服颜色",
  description: "描述",
  inputMode: "ai_and_manual",
  selectionMode: "multi",
  maxItems: 3,
  sortOrder: 1,
  isSystem: false,
  status: "active",
  appliesTo: "all",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("W4 facetManagePanel_two_groups", () => {
  it("两组列表：ai_and_manual 进 AI 组、manual_only 进手工组、inactive 折叠", async () => {
    vi.mocked(listAllTagFacets).mockResolvedValue([
      facet(),
      facet({ key: "auth_state", displayName: "授权状态", inputMode: "manual_only" }),
      facet({ key: "vintage", displayName: "旧货", status: "inactive", isSystem: true }),
    ]);
    renderPanel();
    await waitFor(() => expect(screen.getByText("衣服颜色")).toBeInTheDocument());
    // 两个组标题都在
    expect(screen.getByText("AI 自动打标分类")).toBeInTheDocument();
    expect(screen.getByText("手工填写分类")).toBeInTheDocument();
    expect(screen.queryByText("分类标签")).not.toBeInTheDocument();
    expect(screen.queryByText("画面摘要")).not.toBeInTheDocument();
    expect(screen.getByText(/AI 根据画面内容生成分类标签和画面摘要/)).toBeInTheDocument();
    expect(screen.getByText(/填写后可用于搜索和筛选/)).toBeInTheDocument();
    // 停用的折叠（默认收起，只显示计数）
    expect(screen.getByText(/已停用的分类（1）/)).toBeInTheDocument();
    expect(screen.queryByText("旧货")).not.toBeInTheDocument();
    // 展开停用区后出现 + 有恢复按钮
    fireEvent.click(screen.getByText(/已停用的分类/));
    expect(screen.getByText("旧货")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "恢复" })).toBeInTheDocument();
  });

  it("编辑弹窗：6 字段一个保存按钮（update_tag_facet 单事务）", async () => {
    vi.mocked(listAllTagFacets).mockResolvedValue([facet()]);
    renderPanel();
    await waitFor(() => expect(screen.getByText("衣服颜色")).toBeInTheDocument());
    const facetRow = screen.getByText("衣服颜色").closest("li");
    expect(facetRow).not.toBeNull();
    fireEvent.click(within(facetRow!).getByRole("button", { name: "编辑" }));
    // 弹窗字段
    expect(screen.getByLabelText("分类名称")).toBeInTheDocument();
    expect(screen.getByLabelText("标签描述")).toBeInTheDocument();
    // 改名 + 改归类 → 一次保存
    fireEvent.change(screen.getByLabelText("分类名称"), { target: { value: "服装颜色" } });
    fireEvent.click(screen.getByLabelText("只手工填写"));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(updateTagFacet).toHaveBeenCalledWith(expect.objectContaining({
        key: "clothing_color",
        displayName: "服装颜色",
        inputMode: "manual_only",
      })),
    );
  });

  it("新建弹窗：2 个必填；纯中文名 slugify 空串时自动生成合法随机标识并创建成功（不再硬报错）", async () => {
    vi.mocked(listAllTagFacets).mockResolvedValue([facet()]);
    vi.mocked(createTagFacet).mockResolvedValue(facet());
    renderPanel();
    await waitFor(() => expect(screen.getByText("衣服颜色")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "+ 新增分类" })[0]);
    // 中文名（slugify 产出空）+ 描述都填 → 不报错，直接创建成功（key 用自动兜底 facet_xxx）
    fireEvent.change(screen.getByLabelText("分类名称"), { target: { value: "人物服装颜色" } });
    fireEvent.change(screen.getByLabelText("标签描述"), { target: { value: "人物服装的主色调" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() =>
      expect(createTagFacet).toHaveBeenCalledWith(
        expect.objectContaining({
          displayName: "人物服装颜色",
          key: expect.stringMatching(/^facet_[a-z0-9]+$/),
        }),
      ),
    );
    expect(screen.queryByText(/请填写英文标识/)).not.toBeInTheDocument();
  });

  it("新建弹窗：用户可改自动 key；显式清空自己输入的标识才报错", async () => {
    vi.mocked(listAllTagFacets).mockResolvedValue([facet()]);
    vi.mocked(createTagFacet).mockResolvedValue(facet());
    renderPanel();
    await waitFor(() => expect(screen.getByText("衣服颜色")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "+ 新增分类" })[0]);
    fireEvent.change(screen.getByLabelText("分类名称"), { target: { value: "人物服装颜色" } });
    fireEvent.change(screen.getByLabelText("标签描述"), { target: { value: "人物服装的主色调" } });
    // 覆盖自动 key
    fireEvent.change(screen.getByLabelText("英文标识"), { target: { value: "clothing_color" } });
    // 又清空 → 明确报错
    fireEvent.change(screen.getByLabelText("英文标识"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    expect(await screen.findByText(/英文标识不能为空/)).toBeInTheDocument();
    expect(createTagFacet).not.toHaveBeenCalled();
  });

  it("删除确认：显示精确影响数字；输入分类名后才能确认删除", async () => {
    vi.mocked(listAllTagFacets).mockResolvedValue([facet()]);
    renderPanel();
    await waitFor(() => expect(screen.getByText("衣服颜色")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    // 影响数字（getTagFacetImpact 返回 tagCount=2 assetCount=3）
    expect(await screen.findByText(/将删除 2 个标签/)).toBeInTheDocument();
    expect(screen.getByText(/解除 3 个素材的关联/)).toBeInTheDocument();
    // 未输入名字 → 确认删除禁用
    expect(screen.getByRole("button", { name: "确认删除" })).toBeDisabled();
    // 输入名字 → 启用并调用
    fireEvent.change(screen.getByPlaceholderText("衣服颜色"), { target: { value: "衣服颜色" } });
    expect(screen.getByRole("button", { name: "确认删除" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(deleteTagFacet).toHaveBeenCalledWith("clothing_color"));
  });

  it("停用区恢复按钮调用 restoreTagFacet", async () => {
    vi.mocked(listAllTagFacets).mockResolvedValue([
      facet({ key: "vintage", displayName: "旧货", status: "inactive", isSystem: true }),
    ]);
    renderPanel();
    await waitFor(() => expect(screen.getByText(/已停用的分类（1）/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/已停用的分类/));
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    await waitFor(() => expect(restoreTagFacet).toHaveBeenCalledWith("vintage"));
  });

  it("系统分面不显示删除按钮（Q2：只允许停用）", async () => {
    vi.mocked(listAllTagFacets).mockResolvedValue([
      facet({ key: "scene", displayName: "场景", isSystem: true }),
    ]);
    renderPanel();
    await waitFor(() => expect(screen.getByText("场景")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "删除" })).not.toBeInTheDocument();
    expect(getTagFacetImpact).not.toHaveBeenCalled();
  });

  it("画面摘要作为 AI 子类，行结构与分类一致，编辑/词条各司其职", async () => {
    vi.mocked(listAllTagFacets).mockResolvedValue([facet()]);
    const { onPatchAi, draft } = renderPanel();
    await waitFor(() => expect(screen.getByText("衣服颜色")).toBeInTheDocument());
    const aiSection = screen.getByRole("heading", { name: "AI 自动打标分类" }).closest("section");
    const manualSection = screen.getByRole("heading", { name: "手工填写分类" }).closest("section");
    expect(aiSection).not.toBeNull();
    expect(manualSection).not.toBeNull();
    const facetRow = screen.getByText("衣服颜色").closest("li");
    const summaryRow = within(aiSection!).getByText("画面摘要（一句话描述）").closest("li");
    expect(facetRow).not.toBeNull();
    expect(summaryRow).not.toBeNull();
    expect(summaryRow!.className).toBe(facetRow!.className);
    expect(within(aiSection!).queryByText("查看")).not.toBeInTheDocument();
    expect(within(aiSection!).queryByText("收起")).not.toBeInTheDocument();

    // 编辑：复用分类编辑弹窗的视觉与字段结构
    fireEvent.click(within(summaryRow!).getByRole("button", { name: "编辑" }));
    expect(await screen.findByText(/编辑画面摘要：画面摘要（一句话描述）/)).toBeInTheDocument();
    expect(screen.getByLabelText("分类名称")).toBeDisabled();
    expect(screen.getByLabelText("标签描述")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    // 词条：进入摘要自己的提示词设置，不展示分类字段
    fireEvent.click(within(summaryRow!).getByRole("button", { name: "词条" }));
    expect(await screen.findByText(/画面摘要词条：画面摘要（一句话描述）/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "分类名称" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "标签描述" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /高级/ })).not.toBeInTheDocument();
    const tagging = screen.getByRole("textbox", { name: /AI 打标提示词/ });
    const search = screen.getByRole("textbox", { name: /超级搜索提示词/ });
    expect(tagging).toHaveValue(draft.ai.systemPromptTagging);
    // 输入 → onPatchAi 收到对应 patch
    fireEvent.change(tagging, { target: { value: "你是素材打标助手" } });
    expect(onPatchAi).toHaveBeenCalledWith({ systemPromptTagging: "你是素材打标助手" });
    fireEvent.change(search, { target: { value: "你是搜索助手" } });
    expect(onPatchAi).toHaveBeenCalledWith({ systemPromptSearch: "你是搜索助手" });
  });
});

// ═══════════════ V24（Phase 7-7）：数值分面类型驱动表单 + 转换预览 ═══════════════

describe("V24 facetManagePanel_number_facet_form", () => {
  it("新建弹窗类型第一项：选「数值」→ 值域配置出现；创建后调用 setFacetKind 写类型与配置", async () => {
    vi.mocked(listAllTagFacets).mockResolvedValue([facet()]);
    vi.mocked(createTagFacet).mockResolvedValue(facet());
    vi.mocked(setFacetKind).mockResolvedValue(facet());
    renderPanel();
    await waitFor(() => expect(screen.getByText("衣服颜色")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "+ 新增分类" })[0]);
    expect(await screen.findByText("类型")).toBeTruthy();

    // 选「数值」→ 值域配置出现
    const numberRadio = screen.getByLabelText("数值（如人数）");
    fireEvent.click(numberRadio);
    expect(screen.getByLabelText("数值下限")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("数值下限"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("数值上限"), { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText("数值单位"), { target: { value: "人" } });
    fireEvent.change(screen.getByLabelText("分类名称"), { target: { value: "人数" } });
    fireEvent.change(screen.getByLabelText("标签描述"), { target: { value: "画面中的人数" } });

    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(setFacetKind).toHaveBeenCalled());
    expect(setFacetKind).toHaveBeenCalledWith(
      expect.stringMatching(/^facet_[a-z0-9]+$/),
      "number",
      expect.objectContaining({ numMin: 0, numMax: 50, numUnit: "人" }),
    );
  });

  it("编辑数值分面：显示数值配置区（不可改回标签）；保存同步 setFacetKind", async () => {
    const numberFacet = facet({ key: "people_count", displayName: "人数", facetKind: "number", numMin: 0, numMax: 50, numUnit: "人", numStep: 1 });
    vi.mocked(listAllTagFacets).mockResolvedValue([numberFacet]);
    vi.mocked(setFacetKind).mockResolvedValue(numberFacet);
    renderPanel();
    await screen.findByText("人数");
    fireEvent.click(screen.getAllByRole("button", { name: "编辑" })[0]);
    expect(await screen.findByText("数值设置")).toBeTruthy();
    expect(screen.getByText(/数值类型创建后不可改回标签类型/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("数值上限"), { target: { value: "99" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(setFacetKind).toHaveBeenCalledWith("people_count", "number", expect.objectContaining({ numMax: 99, numUnit: "人" })));
  });

  it("转换为数值型：先 dry-run 预览分桶；存在冲突/歧义时执行按钮禁用（不自动裁决）", async () => {
    const report: ConversionReport = {
      facetKey: "clothing_color",
      parsed: [{ tagId: 1, name: "5", value: 5 }],
      ambiguous: [{ tagId: 2, name: "约5", reason: "约数" }],
      unparseable: [{ tagId: 3, name: "很多", assetCount: 2 }],
      conflicts: [{ assetId: 9, candidates: [[1, 5, "manual"], [2, 6, "ai_unreviewed"]] }],
      hierarchyLoss: 0,
      aliasLoss: 1,
      pendingRejected: 0,
    };
    const numberFacet = facet({ key: "people_count", displayName: "人数", facetKind: "number" });
    vi.mocked(listAllTagFacets).mockResolvedValue([facet(), numberFacet]);
    vi.mocked(convertFacetKind).mockResolvedValue(report);
    renderPanel();
    await screen.findByText("衣服颜色");
    fireEvent.click(screen.getAllByRole("button", { name: "编辑" })[0]);
    fireEvent.click(await screen.findByRole("button", { name: /高级/ }));
    fireEvent.click(await screen.findByText("转换为数值型…"));
    expect(await screen.findByText("转换为数值型 · 预览报告")).toBeTruthy();
    await waitFor(() => expect(convertFacetKind).toHaveBeenCalledWith("clothing_color", true));
    expect(await screen.findByText(/冲突 1 处/)).toBeTruthy();
    const execBtn = screen.getByRole("button", { name: "存在冲突/歧义，先处理" }) as HTMLButtonElement;
    expect(execBtn.disabled).toBe(true);
    expect(convertFacetKind).toHaveBeenCalledTimes(1); // 只 dry-run，未执行
  });
});
