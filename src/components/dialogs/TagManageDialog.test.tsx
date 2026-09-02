/**
 * TagManageDialog 标签治理测试（指导书 §6.5/§12.6）：
 *  - 展示分面治理统计（词条数/素材数/别名数）；
 *  - 「别名」行：显示现有别名并可用 addTagAlias 新增（别名可搜索，复用现有命令）；
 *  - 移动/合并/停用入口存在且复用 updateTag/mergeTags/deactivateTag。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import TagManageDialog from "@/components/dialogs/TagManageDialog";
import { addTagAlias, listTagGovernance } from "@/api/tags";
import { useTagStore } from "@/stores/tagStore";
import type { TagNode } from "@/types/tag";

vi.mock("@/api/tags", () => ({
  addTagAlias: vi.fn().mockResolvedValue(undefined),
  deactivateTag: vi.fn().mockResolvedValue(undefined),
  listTagGovernance: vi.fn().mockResolvedValue([
    { facetKey: "color", tagCount: 2, activeTagCount: 2, deprecatedTagCount: 0, linkedAssetCount: 5, aliasCount: 1, pendingAiItemCount: 0 },
  ]),
  mergeTags: vi.fn().mockResolvedValue(undefined),
  updateTag: vi.fn().mockResolvedValue(undefined),
}));

function mkTree(): TagNode[] {
  return [
    {
      tag: {
        id: 1,
        name: "红色",
        canonicalName: "红色",
        normalizedName: "红色",
        facetKey: "color",
        parentId: null,
        status: "active",
        isSystem: false,
        isPreset: false,
        sortOrder: 0,
        assetCount: 3,
        totalCount: 3,
        aliases: ["绯红"],
        path: "红色",
        facetEffective: true,
      },
      children: [],
    },
    {
      tag: {
        id: 2,
        name: "蓝色",
        canonicalName: "蓝色",
        normalizedName: "蓝色",
        facetKey: "color",
        parentId: null,
        status: "active",
        isSystem: false,
        isPreset: false,
        sortOrder: 1,
        assetCount: 1,
        totalCount: 1,
        aliases: [],
        path: "蓝色",
        facetEffective: true,
      },
      children: [],
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  useTagStore.setState({ tree: mkTree() });
  vi.mocked(listTagGovernance).mockResolvedValue([
    { facetKey: "color", tagCount: 2, activeTagCount: 2, deprecatedTagCount: 0, linkedAssetCount: 5, aliasCount: 1, pendingAiItemCount: 0 },
  ]);
});

describe("TagManageDialog 标签治理（§6.5）", () => {
  it("显示分面治理统计与标签列表", async () => {
    render(<TagManageDialog open onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("红色")).toBeInTheDocument());
    expect(screen.getByText("color")).toBeInTheDocument();
    expect(screen.getByText(/2 个有效标签 · 5 个素材/)).toBeInTheDocument();
  });

  it("别名行显示现有别名并可用 addTagAlias 新增", async () => {
    render(<TagManageDialog open onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("红色")).toBeInTheDocument());

    // 打开别名校验：显示现有别名「绯红」
    fireEvent.click(screen.getAllByRole("button", { name: "别名" })[0]);
    await waitFor(() => expect(screen.getByText("绯红")).toBeInTheDocument());

    // 输入新别名并添加
    fireEvent.change(screen.getByPlaceholderText(/输入别名/), { target: { value: "scarlet" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    await waitFor(() => expect(addTagAlias).toHaveBeenCalledWith(1, "scarlet"));
  });

  it("移动/合并/停用入口存在（复用现有命令）", async () => {
    render(<TagManageDialog open onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("红色")).toBeInTheDocument());

    expect(screen.getAllByRole("button", { name: "移动到…" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "合并到…" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "停用" }).length).toBeGreaterThan(0);
  });
});