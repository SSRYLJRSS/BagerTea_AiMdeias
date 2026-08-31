/**
 * W4 FacetManagePanel 测试：两组列表 + 弹窗化编辑/新建/删除。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import FacetManagePanel from "@/components/settings/FacetManagePanel";
import { listAllTagFacets, createTagFacet, updateTagFacet, deleteTagFacet, getTagFacetImpact, restoreTagFacet } from "@/api/tags";
import type { TagFacet } from "@/types/tag";

vi.mock("@/api/tags", () => ({
  listAllTagFacets: vi.fn(),
  createTagFacet: vi.fn(),
  updateTagFacet: vi.fn().mockResolvedValue(undefined),
  updateTagFacetDisplay: vi.fn().mockResolvedValue(undefined),
  updateTagFacetRules: vi.fn().mockResolvedValue(undefined),
  reorderTagFacets: vi.fn().mockResolvedValue(undefined),
  deleteTagFacet: vi.fn().mockResolvedValue({ tagsDeleted: 2, unlinked: 3, opsDeleted: 0, itemsDeleted: 0 }),
  deactivateTagFacet: vi.fn().mockResolvedValue(undefined),
  restoreTagFacet: vi.fn().mockResolvedValue(undefined),
  getTagFacetImpact: vi.fn().mockResolvedValue({ tagCount: 2, assetCount: 3, aiSuggestionItemCount: 0, tagOpCount: 0 }),
}));

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
      facet({ key: "color", displayName: "色彩", status: "inactive", isSystem: true }),
    ]);
    render(<FacetManagePanel />);
    await waitFor(() => expect(screen.getByText("衣服颜色")).toBeInTheDocument());
    // 两个组标题都在
    expect(screen.getByText("AI 自动打标的分类")).toBeInTheDocument();
    expect(screen.getByText("只手工填写的分类")).toBeInTheDocument();
    // 停用的折叠（默认收起，只显示计数）
    expect(screen.getByText(/已停用的分类（1）/)).toBeInTheDocument();
    expect(screen.queryByText("色彩")).not.toBeInTheDocument();
    // 展开停用区后出现 + 有恢复按钮
    fireEvent.click(screen.getByText(/已停用的分类/));
    expect(screen.getByText("色彩")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "恢复" })).toBeInTheDocument();
  });

  it("编辑弹窗：6 字段一个保存按钮（update_tag_facet 单事务）", async () => {
    vi.mocked(listAllTagFacets).mockResolvedValue([facet()]);
    render(<FacetManagePanel />);
    await waitFor(() => expect(screen.getByText("衣服颜色")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    // 弹窗字段
    expect(screen.getByLabelText("分类名称")).toBeInTheDocument();
    expect(screen.getByLabelText("这类标签是什么")).toBeInTheDocument();
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

  it("新建弹窗：2 个必填；CJK 名称自动 key 为空时提示输入英文标识", async () => {
    vi.mocked(listAllTagFacets).mockResolvedValue([facet()]);
    vi.mocked(createTagFacet).mockResolvedValue(facet());
    render(<FacetManagePanel />);
    await waitFor(() => expect(screen.getByText("衣服颜色")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "+ 新增分类" })[0]);
    // 中文名（slugify 产出空）+ 描述都填 → 报错要求英文标识
    fireEvent.change(screen.getByLabelText("分类名称"), { target: { value: "人物服装颜色" } });
    fireEvent.change(screen.getByLabelText("这类标签是什么"), { target: { value: "人物服装的主色调" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    expect(await screen.findByText(/请填写英文标识/)).toBeInTheDocument();
    // 补英文标识 → 创建成功
    fireEvent.change(screen.getByLabelText("英文标识"), { target: { value: "clothing_color" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() =>
      expect(createTagFacet).toHaveBeenCalledWith(expect.objectContaining({ key: "clothing_color", displayName: "人物服装颜色" })),
    );
  });

  it("删除确认：显示精确影响数字；输入分类名后才能确认删除", async () => {
    vi.mocked(listAllTagFacets).mockResolvedValue([facet()]);
    render(<FacetManagePanel />);
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
      facet({ key: "color", displayName: "色彩", status: "inactive", isSystem: true }),
    ]);
    render(<FacetManagePanel />);
    await waitFor(() => expect(screen.getByText(/已停用的分类（1）/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/已停用的分类/));
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    await waitFor(() => expect(restoreTagFacet).toHaveBeenCalledWith("color"));
  });

  it("系统分面不显示删除按钮（Q2：只允许停用）", async () => {
    vi.mocked(listAllTagFacets).mockResolvedValue([
      facet({ key: "scene", displayName: "场景", isSystem: true }),
    ]);
    render(<FacetManagePanel />);
    await waitFor(() => expect(screen.getByText("场景")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "删除" })).not.toBeInTheDocument();
    expect(getTagFacetImpact).not.toHaveBeenCalled();
  });
});
