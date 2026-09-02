/**
 * FB6 需求四：TagTree 测试——统一标题行 + 全部展开/全部收起。
 *  - 有可展开节点时显示「全部展开」；点击后所有有子节点的节点出现在 flattenVisible 结果中；
 *  - 再点「全部收起」恢复；单节点折叠后全局按钮文案正确；
 *  - 空树按钮隐藏；按钮只改展开状态，不改选中筛选。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import TagTree from "@/components/library/TagTree";
import { flattenVisible, useTagStore } from "@/stores/tagStore";
import { useLibraryStore } from "@/stores/libraryStore";
import type { Tag, TagNode } from "@/types/tag";

vi.mock("@/api/tags", () => ({
  listTags: vi.fn().mockResolvedValue([]),
  listTagFacets: vi.fn().mockResolvedValue([]),
  listTagsByFacet: vi.fn().mockResolvedValue([]),
  searchTagCandidates: vi.fn().mockResolvedValue([]),
}));

const mkTag = (id: number, name: string, facetKey = "subject", parentId: number | null = null): Tag => ({
  id,
  name,
  canonicalName: name,
  normalizedName: name,
  facetKey,
  parentId,
  status: "active",
  isSystem: false,
  isPreset: false,
  sortOrder: id,
  assetCount: 1,
  totalCount: 1,
  aliases: [],
  path: name,
  facetEffective: true,
});

/** 两级树：1(人像) → 2(特写)；3(风景) → 4(海岸)；默认只展开 1（部分展开态） */
const TREE: TagNode[] = [
  { tag: mkTag(1, "人像"), children: [{ tag: mkTag(2, "特写", "subject", 1), children: [] }] },
  { tag: mkTag(3, "风景"), children: [{ tag: mkTag(4, "海岸", "subject", 3), children: [] }] },
];

beforeEach(() => {
  useTagStore.setState({
    tree: TREE,
    facets: [],
    treesByFacet: {},
    candidates: [],
    loading: false,
    expanded: new Set([1]),
  });
  useLibraryStore.setState((s) => ({
    ...s,
    filter: {
      ...s.filter,
      assetType: "all",
      untaggedOnly: false,
      tagId: null,
      facetFilters: [],
      excludeTagIds: [],
      trashOnly: false,
    },
  }));
});

describe("TagTree 全部展开/全部收起（FB6 需求四）", () => {
  it("标题行左侧「智能标签」、右侧「全部展开」；收起态点击后所有子节点可见且按钮变「全部收起」", () => {
    render(<TagTree />);
    expect(screen.getByText("智能标签")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: "全部展开" });
    fireEvent.click(btn);
    // 展开后：父与子都可见（flattenVisible 覆盖所有可展开节点）
    const visible = flattenVisible(useTagStore.getState().tree, useTagStore.getState().expanded);
    expect(visible.map((r) => r.node.tag.id)).toEqual([1, 2, 3, 4]);
    expect(useTagStore.getState().expanded.has(1)).toBe(true);
    expect(useTagStore.getState().expanded.has(3)).toBe(true);
    expect(screen.getByRole("button", { name: "全部收起" })).toBeInTheDocument();
  });

  it("全部收起后回到顶级可见，单节点箭头仍可单独展开", () => {
    useTagStore.setState({ expanded: new Set([1, 3]) });
    render(<TagTree />);
    fireEvent.click(screen.getByRole("button", { name: "全部收起" }));
    expect(useTagStore.getState().expanded.size).toBe(0);
    // 单节点展开仍可用（多行都有「展开」箭头，取第一个 = 人像）
    fireEvent.click(screen.getAllByRole("button", { name: "展开" })[0]);
    expect(useTagStore.getState().expanded.has(1)).toBe(true);
  });

  it("单节点折叠后全局文案正确（部分展开 → 显示「全部展开」）", () => {
    useTagStore.setState({ expanded: new Set([1, 3]) });
    render(<TagTree />);
    expect(screen.getByRole("button", { name: "全部收起" })).toBeInTheDocument();
    // 折叠节点 1（全部收起后单独展开它再折叠 → 回到部分展开）
    fireEvent.click(screen.getAllByRole("button", { name: "折叠" })[0]);
    expect(screen.getByRole("button", { name: "全部展开" })).toBeInTheDocument();
  });

  it("空树时展开控制按钮隐藏", () => {
    useTagStore.setState({ tree: [], expanded: new Set() });
    render(<TagTree />);
    expect(screen.queryByRole("button", { name: "全部展开" })).toBeNull();
    expect(screen.queryByRole("button", { name: "全部收起" })).toBeNull();
    expect(screen.getByText("智能标签")).toBeInTheDocument();
  });

  it("点击全局按钮不改变选中筛选", () => {
    render(<TagTree />);
    fireEvent.click(screen.getByRole("button", { name: "全部展开" }));
    const { filter } = useLibraryStore.getState();
    expect(filter.facetFilters).toEqual([]);
    expect(filter.untaggedOnly).toBe(false);
  });
});
