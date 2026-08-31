import { beforeEach, describe, expect, it, vi, Mock } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import QueryBuilder from "@/components/supersearch/QueryBuilder";
import { useSuperSearchStore } from "@/stores/superSearchStore";
import { useTagStore } from "@/stores/tagStore";
import { listSuperAssets } from "@/api/superSearch";
import type { QueryExpr } from "@/types/queryExpr";

vi.mock("@/api/assets", () => ({
  listAssets: vi.fn().mockResolvedValue({ items: [], total: 0, hasMore: false }),
  listAssetIds: vi.fn().mockResolvedValue([]),
  getAssetUrls: vi.fn().mockResolvedValue([]),
  revealInFolder: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/api/tags", () => ({
  listTags: vi.fn().mockResolvedValue([]),
  listTagFacets: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/api/superSearch", () => ({
  listSuperAssets: vi.fn().mockResolvedValue({ items: [], total: 0, hasMore: false }),
  listSuperAssetIds: vi.fn().mockResolvedValue([]),
  aiParseSearchQuery: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  useTagStore.setState({ tree: [], loading: false, treesByFacet: {}, expanded: new Set() });
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
    resolvedTags: [],
  });
});

describe("QueryBuilder", () => {
  it("空状态显示添加条件入口", () => {
    render(<QueryBuilder />);
    expect(screen.getByRole("button", { name: "+ 添加第一个条件" })).toBeInTheDocument();
  });

  it("添加条件后生成 expr，并且连接模式可生成 OR", () => {
    render(<QueryBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "+ 添加第一个条件" }));
    expect(useSuperSearchStore.getState().expr).toBeUndefined();
    fireEvent.change(screen.getByLabelText("条件字段"), { target: { value: "assetType" } });
    fireEvent.change(screen.getByLabelText("条件值"), { target: { value: "image" } });
    expect(useSuperSearchStore.getState().expr).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "+ 添加条件" }));
    const fields = screen.getAllByLabelText("条件字段");
    fireEvent.change(fields[1], { target: { value: "assetType" } });
    const values = screen.getAllByLabelText("条件值");
    fireEvent.change(values[1], { target: { value: "video" } });
    fireEvent.change(screen.getByLabelText("条件连接方式"), { target: { value: "or" } });
    const expr = useSuperSearchStore.getState().expr;
    expect(expr).toBeTruthy();
    expect(expr?.op).toBe("or");
    expect(screen.getByText("或者")).toBeInTheDocument();
  });

  it("删除行恢复空表达式", () => {
    render(<QueryBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "+ 添加第一个条件" }));
    const del = screen.getByRole("button", { name: "删除条件" });
    fireEvent.click(del);
    expect(useSuperSearchStore.getState().expr).toBeUndefined();
  });

  it("连续输入时保持焦点，不因 store 更新重建输入框", () => {
    render(<QueryBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "+ 添加第一个条件" }));
    fireEvent.change(screen.getByLabelText("条件字段"), { target: { value: "search" } });
    const input = screen.getByPlaceholderText("输入关键词");
    input.focus();
    fireEvent.change(input, { target: { value: "海" } });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "海边" } });
    expect(document.activeElement).toBe(input);
    // 输入期间只写本地 draft，不提交到 store
    expect(useSuperSearchStore.getState().expr).toBeUndefined();
  });

  it("输入过程中不触发后端查询", () => {
    render(<QueryBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "+ 添加第一个条件" }));
    fireEvent.change(screen.getByLabelText("条件字段"), { target: { value: "search" } });
    const input = screen.getByPlaceholderText("输入关键词");
    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.change(input, { target: { value: "ab" } });
    fireEvent.change(input, { target: { value: "abc" } });
    expect(useSuperSearchStore.getState().expr).toBeUndefined();
    expect(listSuperAssets as Mock).not.toHaveBeenCalled();
  });

  it("Enter 提交后查询条件正确", () => {
    render(<QueryBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "+ 添加第一个条件" }));
    fireEvent.change(screen.getByLabelText("条件字段"), { target: { value: "search" } });
    const input = screen.getByPlaceholderText("输入关键词");
    fireEvent.change(input, { target: { value: "海边" } });
    expect(useSuperSearchStore.getState().expr).toBeUndefined();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useSuperSearchStore.getState().expr).toEqual({ op: "leaf", cond: { type: "search", value: "海边" } });
  });

  it("失焦提交后查询条件正确", () => {
    render(<QueryBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "+ 添加第一个条件" }));
    fireEvent.change(screen.getByLabelText("条件字段"), { target: { value: "search" } });
    const input = screen.getByPlaceholderText("输入关键词");
    fireEvent.change(input, { target: { value: "海边" } });
    expect(useSuperSearchStore.getState().expr).toBeUndefined();
    fireEvent.blur(input);
    expect(useSuperSearchStore.getState().expr).toEqual({ op: "leaf", cond: { type: "search", value: "海边" } });
  });

  it("添加新条件不会破坏已有输入行", () => {
    render(<QueryBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "+ 添加第一个条件" }));
    fireEvent.change(screen.getByLabelText("条件字段"), { target: { value: "search" } });
    const input = screen.getByPlaceholderText("输入关键词");
    fireEvent.change(input, { target: { value: "海边" } });
    fireEvent.click(screen.getByRole("button", { name: "+ 添加条件" }));
    const inputs = screen.getAllByPlaceholderText("输入关键词");
    expect(inputs).toHaveLength(1);
    expect((inputs[0] as HTMLInputElement).value).toBe("海边");
  });

  it("删除条件后其余行焦点和值正常", () => {
    render(<QueryBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "+ 添加第一个条件" }));
    fireEvent.change(screen.getByLabelText("条件字段"), { target: { value: "search" } });
    const input = screen.getByPlaceholderText("输入关键词");
    fireEvent.change(input, { target: { value: "海边" } });
    fireEvent.click(screen.getByRole("button", { name: "+ 添加条件" }));
    const delButtons = screen.getAllByRole("button", { name: "删除条件" });
    expect(delButtons).toHaveLength(2);
    // 删除第二条（tag）行，第一条 search 行仍保留且值不变
    fireEvent.click(delButtons[1]);
    const inputs = screen.getAllByPlaceholderText("输入关键词");
    expect(inputs).toHaveLength(1);
    expect((inputs[0] as HTMLInputElement).value).toBe("海边");
  });

  it("数字条件清空后不会生成等于 0", () => {
    render(<QueryBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "+ 添加第一个条件" }));
    fireEvent.change(screen.getByLabelText("条件字段"), { target: { value: "iso" } });
    const input = screen.getByRole("spinbutton", { name: "条件值" });
    fireEvent.change(input, { target: { value: "800" } });
    expect(useSuperSearchStore.getState().expr).toBeUndefined();
    fireEvent.blur(input);
    expect(useSuperSearchStore.getState().expr).toBeTruthy();
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(useSuperSearchStore.getState().expr).toBeUndefined();
  });

  it("日期条件清空后不会生成 1970 年日期", () => {
    render(<QueryBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "+ 添加第一个条件" }));
    fireEvent.change(screen.getByLabelText("条件字段"), { target: { value: "taken_at" } });
    const input = screen.getByLabelText("条件值");
    fireEvent.change(input, { target: { value: "2025-08-24" } });
    expect(useSuperSearchStore.getState().expr).toBeTruthy();
    fireEvent.change(input, { target: { value: "" } });
    expect(useSuperSearchStore.getState().expr).toBeUndefined();
  });

  it("嵌套树（OR）显示「复杂条件（N 项）」摘要；新增条件以 AND 合并到整棵现有 expr（§9.6.1）", () => {
    const orTree: QueryExpr = {
      op: "or",
      children: [
        { op: "and", children: [{ op: "leaf", cond: { type: "search", value: "海边", scope: "all" } }] },
        { op: "and", children: [{ op: "leaf", cond: { type: "search", value: "日落", scope: "all" } }] },
      ],
    };
    useSuperSearchStore.setState({ expr: orTree });
    render(<QueryBuilder />);
    // 只读摘要：复杂条件（2 项），不渲染可编辑行
    expect(screen.getByText(/复杂条件（2 项）/)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("输入关键词")).not.toBeInTheDocument();
    // 新增条件入口仍可用（不静默禁用）
    const addBtn = screen.getByRole("button", { name: "+ 添加第一个条件" });
    expect(addBtn).toBeEnabled();
    fireEvent.click(addBtn);
    fireEvent.change(screen.getByLabelText("条件字段"), { target: { value: "search" } });
    const input = screen.getByPlaceholderText("输入关键词");
    fireEvent.change(input, { target: { value: "夜景" } });
    fireEvent.blur(input);
    const expr = useSuperSearchStore.getState().expr;
    expect(expr?.op).toBe("and");
    const children = expr && expr.op === "and" ? expr.children : [];
    // 手动条件 leaf 已与整棵 OR 树 AND 合并（DraftInput 提交的 search cond 无 scope 字段 = 默认 all）
    expect(children).toContainEqual({ op: "leaf", cond: { type: "search", value: "夜景" } });
    // OR 子树仍在（未被扁平化）
    const orChild = children.find((c) => c.op === "or") as QueryExpr | undefined;
    expect(orChild).toBeTruthy();
  });

  it("tagId 不在 tagStore 时从 resolvedTags 生成 synthetic option（§9.8）", () => {
    useSuperSearchStore.setState({ resolvedTags: [{ facetKey: "subject", text: "银杏", tagId: 99, path: "" }] });
    render(<QueryBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "+ 添加第一个条件" }));
    // 默认 tag 条件：synthetic option 可选项（名称来自 resolvedTags，绝无空「选择标签」之外裸奔）
    const select = screen.getByLabelText("条件值") as HTMLSelectElement;
    expect(Array.from(select.options).some((o) => o.textContent?.startsWith("银杏"))).toBe(true);
  });

  it("expr 中已含未知 tagId：下拉显示「标签 #id」占位而非退回空（§9.8）", () => {
    useSuperSearchStore.setState({
      expr: { op: "leaf", cond: { type: "tag", facetKey: "custom", tagIds: [123], mode: "any", includeDescendants: false } },
      resolvedTags: [],
    });
    render(<QueryBuilder />);
    const select = screen.getByLabelText("条件值") as HTMLSelectElement;
    expect(select.value).toBe("123");
    expect(Array.from(select.options).some((o) => o.textContent?.startsWith("标签 #123"))).toBe(true);
  });
});
