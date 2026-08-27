/**
 * FacetManagePanel 测试（指导书 §9.2/§9.5/§12.4）：
 * - 分面列表显示 key/状态/适用媒体；展开详情同一上下文包含 基本规则 + AI 行为 + 分类词条入口；
 * - 新增分类调用 createTagFacet；
 * - AI 行为通过 onPatchAiConfig 更新设置草稿（不重复存储结构，§12.4）；
 * - 展开 AI 行为不影响「恢复」按钮可用性（词条入口标题体现上下文）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import FacetManagePanel from "@/components/settings/FacetManagePanel";
import { listAllTagFacets, createTagFacet } from "@/api/tags";
import type { TagFacet } from "@/types/tag";

vi.mock("@/api/tags", () => ({
  listAllTagFacets: vi.fn(),
  createTagFacet: vi.fn(),
  updateTagFacetDisplay: vi.fn().mockResolvedValue(undefined),
  updateTagFacetRules: vi.fn().mockResolvedValue(undefined),
  deactivateTagFacet: vi.fn().mockResolvedValue(undefined),
  restoreTagFacet: vi.fn().mockResolvedValue(undefined),
  getTagFacetImpact: vi.fn().mockResolvedValue({ tagCount: 0, assetCount: 0, aiConfigCount: 0 }),
}));

const facet = (over: Partial<TagFacet> = {}): TagFacet => ({
  key: "clothing_color",
  displayName: "衣服颜色",
  description: "描述",
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

describe("FacetManagePanel 分面生命周期（§9.2）", () => {
  it("列出分面（含 key、状态、适用媒体）", async () => {
    vi.mocked(listAllTagFacets).mockResolvedValue([
      facet(),
      facet({ key: "scene", displayName: "场景", isSystem: true, status: "inactive" }),
    ]);
    render(<FacetManagePanel />);
    await waitFor(() => expect(screen.getByText("衣服颜色")).toBeInTheDocument());
    expect(screen.getByText("场景")).toBeInTheDocument();
    expect(screen.getByText("clothing_color")).toBeInTheDocument();
  });

  it("点击「新增分类」打开表单并提交调用 createTagFacet", async () => {
    vi.mocked(listAllTagFacets).mockResolvedValue([facet()]);
    vi.mocked(createTagFacet).mockResolvedValue(facet());
    render(<FacetManagePanel />);
    await waitFor(() => expect(screen.getByText("衣服颜色")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "+ 新增分类" }));
    fireEvent.change(screen.getByPlaceholderText("显示名称（必填）"), { target: { value: "Clothing Color" } });
    fireEvent.click(screen.getByRole("button", { name: "创建分类" }));

    await waitFor(() =>
      expect(createTagFacet).toHaveBeenCalledWith(
        expect.objectContaining({ displayName: "Clothing Color", key: "clothing_color" }),
      ),
    );
  });

  it("展开分面详情：同一上下文包含 基本规则 / AI 行为 / 分类词条入口（§9.2/§9.5）", async () => {
    vi.mocked(listAllTagFacets).mockResolvedValue([facet()]);
    const onPatchAiConfig = vi.fn();
    render(
      <FacetManagePanel
        aiConfigs={[{ facetKey: "clothing_color", enabledForAi: true, hint: "主色参考", visibleInWorkbench: true }]}
        onPatchAiConfig={onPatchAiConfig}
      />,
    );
    await waitFor(() => expect(screen.getByText("衣服颜色")).toBeInTheDocument());

    // 展开详情
    fireEvent.click(screen.getByText("衣服颜色"));
    // 三段式标题出现
    expect(screen.getByText("基本规则")).toBeInTheDocument();
    expect(screen.getByText("AI 行为")).toBeInTheDocument();
    expect(screen.getByText("分类词条")).toBeInTheDocument();
    // AI 行为已有草稿值回显（hint 不重复存储结构，仅 AI 覆盖）
    expect(screen.getByDisplayValue("主色参考")).toBeInTheDocument();

    // 修改 hint → 回调设置草稿（不另存一份结构）
    fireEvent.change(screen.getByDisplayValue("主色参考"), { target: { value: "新的说明" } });
    expect(onPatchAiConfig).toHaveBeenCalledWith("clothing_color", { hint: "新的说明" });

    // 分类词条入口打开二级编辑器（标题带分面上下文，§9.3）
    fireEvent.click(screen.getByRole("button", { name: "管理词条" }));
    await waitFor(() => expect(screen.getByText("分类词条：衣服颜色")).toBeInTheDocument());
  });

  it("展开详情后停用/恢复按钮可用（同一上下文治理）", async () => {
    vi.mocked(listAllTagFacets).mockResolvedValue([facet({ status: "inactive" })]);
    render(<FacetManagePanel />);
    await waitFor(() => expect(screen.getByText("衣服颜色")).toBeInTheDocument());
    fireEvent.click(screen.getByText("衣服颜色"));
    expect(screen.getByRole("button", { name: "恢复分类" })).toBeInTheDocument();
  });
});