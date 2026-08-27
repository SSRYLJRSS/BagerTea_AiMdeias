import { beforeEach, describe, expect, it, vi, Mock } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import QueryBuilder from "@/components/supersearch/QueryBuilder";
import { useSuperSearchStore } from "@/stores/superSearchStore";
import { useTagStore } from "@/stores/tagStore";
import { listSuperAssets } from "@/api/superSearch";

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
    query: { search: "", assetType: "all", untaggedOnly: false, facetFilters: [], excludeTagIds: [], missingFacetKeys: [], metadataFilters: [], sortBy: "created_at", sortDir: "desc" },
    expr: undefined,
    items: [],
    total: 0,
    loading: false,
    error: null,
    aiInput: "",
    aiLoading: false,
    aiExplanation: null,
    warnings: [],
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
});
