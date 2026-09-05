import { beforeEach, describe, expect, it, vi, Mock } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import QueryBuilder from "@/components/supersearch/QueryBuilder";
import { useSuperSearchStore } from "@/stores/superSearchStore";
import { useTagStore } from "@/stores/tagStore";
import { useMetadataStore } from "@/stores/metadataStore";
import { useNumericDomainStore } from "@/stores/numericDomainStore";
import { listSuperAssets } from "@/api/superSearch";
import type { NumericDomain } from "@/types/asset";
import type { LeafCond, QueryExpr } from "@/types/queryExpr";
import type { SearchPlanV3 } from "@/types/superSearch";
import { shortcutEndMs, shortcutStartMs } from "@/utils/dateShortcuts";

/** U-1：字段下拉已改造成可搜索 combobox —— 打开第 row 行字段列表并点选 label 选项 */
function pickField(label: string, row = 0) {
  const combos = screen.getAllByRole("combobox", { name: "条件字段" });
  fireEvent.focus(combos[row]);
  const option = screen.getAllByRole("option", { name: label })[0];
  fireEvent.click(option);
}

vi.mock("@/api/assets", () => ({
  listAssets: vi.fn().mockResolvedValue({ items: [], total: 0, hasMore: false }),
  listAssetIds: vi.fn().mockResolvedValue([]),
  listMetadataFacets: vi.fn().mockResolvedValue([]),
  getNumericDomains: vi.fn().mockResolvedValue([]),
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
  diagnoseSearchPlan: vi.fn().mockResolvedValue({ leaves: [], should: [] }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear(); // U-1 最近使用字段持久化：测试间互不污染
  useTagStore.setState({ tree: [], loading: false, treesByFacet: {}, expanded: new Set() });
  useNumericDomainStore.setState({ domains: [], loading: false, loaded: false });
  useMetadataStore.setState({ facets: [], loading: false, loaded: false });
  useSuperSearchStore.setState({
    query: { search: "", assetType: "all", untaggedOnly: false, facetFilters: [], excludeTagIds: [], metadataFilters: [], sortBy: "created_at", sortDir: "desc" },
    expr: undefined,
    plan: null, // U-5 加分项单源：测试间不残留 should
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
    pickField("素材类型");
    fireEvent.change(screen.getByLabelText("条件值"), { target: { value: "image" } });
    expect(useSuperSearchStore.getState().expr).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "+ 添加条件" }));
    pickField("素材类型", 1);
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
    pickField("关键词");
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
    pickField("关键词");
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
    pickField("关键词");
    const input = screen.getByPlaceholderText("输入关键词");
    fireEvent.change(input, { target: { value: "海边" } });
    expect(useSuperSearchStore.getState().expr).toBeUndefined();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useSuperSearchStore.getState().expr).toEqual({ op: "leaf", cond: { type: "search", value: "海边" } });
  });

  it("失焦提交后查询条件正确", () => {
    render(<QueryBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "+ 添加第一个条件" }));
    pickField("关键词");
    const input = screen.getByPlaceholderText("输入关键词");
    fireEvent.change(input, { target: { value: "海边" } });
    expect(useSuperSearchStore.getState().expr).toBeUndefined();
    fireEvent.blur(input);
    expect(useSuperSearchStore.getState().expr).toEqual({ op: "leaf", cond: { type: "search", value: "海边" } });
  });

  it("添加新条件不会破坏已有输入行", () => {
    render(<QueryBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "+ 添加第一个条件" }));
    pickField("关键词");
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
    pickField("关键词");
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
    pickField("ISO");
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
    pickField("拍摄时间");
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
    pickField("关键词");
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
    // 默认 tag 条件：打开面板出现 synthetic 可选项（名称来自 resolvedTags，绝无「选择标签」裸奔）
    fireEvent.click(screen.getByRole("button", { name: "选择标签" }));
    expect(screen.getByRole("checkbox", { name: "银杏" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "银杏" }));
    const expr = useSuperSearchStore.getState().expr;
    // S5 5-2：tag 叶子现在带 termQuery/termMatch 字段（词查缺省 null/alias）
    expect(expr).toEqual({ op: "leaf", cond: { type: "tag", facetKey: "subject", tagIds: [99], mode: "any", includeDescendants: true, termQuery: null, termMatch: "alias" } });
    expect(screen.getByRole("button", { name: "移除 银杏" })).toBeInTheDocument();
  });

  it("expr 中已含未知 tagId：chip 显示「标签 #id」而非退回空（§9.8；多选语义）", () => {
    useSuperSearchStore.setState({
      expr: { op: "leaf", cond: { type: "tag", facetKey: "custom", tagIds: [123], mode: "any", includeDescendants: false } },
      resolvedTags: [],
    });
    render(<QueryBuilder />);
    // 已选 chip 显示未知 id 占位，可单个移除
    expect(screen.getByRole("button", { name: "移除 标签 #123" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "选择标签" }));
    const cb = screen.getByRole("checkbox", { name: "标签 #123" });
    expect(cb).toHaveAttribute("aria-checked", "true");
  });
});

describe("W0-3 条件公式包含根级标签", () => {
  it("queryBuilder_includes_root_tags：根级标签（parentId=null，find_or_create_canonical 的产物）出现在标签下拉中", () => {
    const mkTag = (id: number, name: string, facetKey: string) => ({
      id, name, canonicalName: name, normalizedName: name, facetKey,
      parentId: null, status: "active" as const, isSystem: false, isPreset: false,
      sortOrder: 0, assetCount: 0, totalCount: 0, aliases: [], path: name, facetEffective: true,
    });
    // 模拟真实库：19 个标签全部为根级（无父子层级）
    useTagStore.setState({
      tree: [
        { tag: mkTag(1, "海边", "scene"), children: [] },
        { tag: mkTag(2, "人像", "subject"), children: [] },
        { tag: mkTag(3, "胶片", "style"), children: [] },
      ],
      loading: false, treesByFacet: {}, expanded: new Set(),
    });
    render(<QueryBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "+ 添加第一个条件" }));
    pickField("包含标签");
    // 标签面板应包含全部三个根级标签（旧代码 walk(root.children) 会漏光）
    fireEvent.click(screen.getByRole("button", { name: "选择标签" }));
    expect(screen.getByRole("checkbox", { name: "海边" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "人像" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "胶片" })).toBeInTheDocument();
  });
});

/** W3-3：QueryBuilder 三合一改造（定位字段 / optgroup / 多选 / facet_has_any） */
describe("W3-3 QueryBuilder 三合一", () => {
  const mkTag = (id: number, name: string, facetKey: string) => ({
    id, name, canonicalName: name, normalizedName: name, facetKey,
    parentId: null, status: "active" as const, isSystem: false, isPreset: false,
    sortOrder: 0, assetCount: 0, totalCount: 0, aliases: [], path: name, facetEffective: true,
  });

  it("_includes_root_tags：根级标签出现在面板（W0-3 回归守护）", () => {
    useTagStore.setState({
      tree: [
        { tag: mkTag(1, "海边", "scene"), children: [] },
        { tag: mkTag(2, "人像", "subject"), children: [] },
      ],
      loading: false, treesByFacet: {}, expanded: new Set(),
    });
    render(<QueryBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "+ 添加第一个条件" }));
    pickField("包含标签");
    fireEvent.click(screen.getByRole("button", { name: "选择标签" }));
    expect(screen.getByRole("checkbox", { name: "海边" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "人像" })).toBeInTheDocument();
  });

  it("_groups_by_facet：面板按分面分组显示", () => {
    useTagStore.setState({
      tree: [
        { tag: mkTag(1, "海边", "scene"), children: [] },
        { tag: mkTag(2, "公园", "scene"), children: [] },
        { tag: mkTag(3, "人像", "subject"), children: [] },
      ],
      loading: false, treesByFacet: {}, expanded: new Set(),
    });
    render(<QueryBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "+ 添加第一个条件" }));
    pickField("包含标签");
    fireEvent.click(screen.getByRole("button", { name: "选择标签" }));
    expect(screen.getByText("scene")).toBeInTheDocument();
    expect(screen.getByText("subject")).toBeInTheDocument();
  });

  it("_multi_select_tags：面板逐项勾选，多选写入 tagIds（弃用 Ctrl+点击）", () => {
    useTagStore.setState({
      tree: [
        { tag: mkTag(1, "海边", "scene"), children: [] },
        { tag: mkTag(2, "公园", "scene"), children: [] },
      ],
      loading: false, treesByFacet: {}, expanded: new Set(),
    });
    render(<QueryBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "+ 添加第一个条件" }));
    pickField("包含标签");
    fireEvent.click(screen.getByRole("button", { name: "选择标签" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "海边" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "公园" }));
    const expr = useSuperSearchStore.getState().expr;
    expect(expr).toBeTruthy();
    if (expr?.op === "leaf" && expr.cond.type === "tag") {
      expect(expr.cond.tagIds).toEqual(expect.arrayContaining([1, 2]));
      expect(expr.cond.facetKey).toBe("scene");
    } else {
      throw new Error("expected single tag leaf");
    }
  });

  it("_has_location_field_present：字段下拉含定位组三个字段", () => {
    render(<QueryBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "+ 添加第一个条件" }));
    const combo = screen.getByRole("combobox", { name: "条件字段" });
    fireEvent.focus(combo);
    const texts = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    expect(texts).toContain("纬度");
    expect(texts).toContain("经度");
    expect(texts).toContain("有无定位");
    const groups = screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"));
    expect(groups).toContain("定位");
  });
});

/** U-7 ①：文件大小单位下拉 —— 显示按 KB/MB/GB 换算，提交始终是字节。 */
describe("U-7 数值单位下拉", () => {
  const openSizeRow = () => {
    render(<QueryBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "+ 添加第一个条件" }));
    pickField("文件大小");
  };

  it("queryBuilder_unit_dropdown_converts_to_bytes：选 KB 后输入 5 → 5120 字节", () => {
    openSizeRow();
    const unit = screen.getByLabelText("数值单位") as HTMLSelectElement;
    expect(unit.value).toBe("MB"); // 默认 MB（旧行为）
    fireEvent.change(unit, { target: { value: "KB" } });
    const input = screen.getByRole("spinbutton", { name: "条件值" });
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.blur(input);
    const expr = useSuperSearchStore.getState().expr;
    expect(expr).toEqual({ op: "leaf", cond: { type: "metadata", filter: { key: "file_size", op: "eq", value: 5120, unit: "KB" } } });
  });

  it("默认 MB：输入 5 → 5242880 字节", () => {
    openSizeRow();
    const input = screen.getByRole("spinbutton", { name: "条件值" });
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.blur(input);
    const expr = useSuperSearchStore.getState().expr;
    expect(expr).toEqual({ op: "leaf", cond: { type: "metadata", filter: { key: "file_size", op: "eq", value: 5242880, unit: "MB" } } });
  });

  it("选 GB 后输入 1 → 1073741824 字节", () => {
    openSizeRow();
    fireEvent.change(screen.getByLabelText("数值单位"), { target: { value: "GB" } });
    const input = screen.getByRole("spinbutton", { name: "条件值" });
    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.blur(input);
    const expr = useSuperSearchStore.getState().expr;
    expect(expr).toEqual({ op: "leaf", cond: { type: "metadata", filter: { key: "file_size", op: "eq", value: 1073741824, unit: "GB" } } });
  });

  it("unit 切换重算已有值（字节不变，显示按新单位换算）", () => {
    useSuperSearchStore.setState({
      expr: { op: "leaf", cond: { type: "metadata", filter: { key: "file_size", op: "eq", value: 5 * 1024 * 1024 } } },
    });
    render(<QueryBuilder />);
    const unit = screen.getByLabelText("数值单位") as HTMLSelectElement;
    expect(unit.value).toBe("MB");
    expect((screen.getByRole("spinbutton", { name: "条件值" }) as HTMLInputElement).value).toBe("5");
    fireEvent.change(unit, { target: { value: "KB" } });
    expect((screen.getByRole("spinbutton", { name: "条件值" }) as HTMLInputElement).value).toBe("5120");
    expect(useSuperSearchStore.getState().expr).toEqual({ op: "leaf", cond: { type: "metadata", filter: { key: "file_size", op: "eq", value: 5242880, unit: "KB" } } });
  });

  it("P1-3 亚 KB 小值不静默归零：500 字节显示 0.488 KB，失焦提交不回写 0 字节", () => {
    useSuperSearchStore.setState({
      expr: { op: "leaf", cond: { type: "metadata", filter: { key: "file_size", op: "eq", value: 500 } } },
    });
    render(<QueryBuilder />);
    // 500B 在 MB 下会显示 0.000 → 必须自动落到 KB，避免失焦把条件改成 0 字节
    const unit = screen.getByLabelText("数值单位") as HTMLSelectElement;
    expect(unit.value).toBe("KB");
    const input = screen.getByRole("spinbutton", { name: "条件值" }) as HTMLInputElement;
    expect(input.value).not.toBe("0");
    expect(Number(input.value)).toBeCloseTo(0.488, 2);
    // 失焦（不改数值）不回写 0 字节
    fireEvent.blur(input);
    expect(useSuperSearchStore.getState().expr).toEqual({ op: "leaf", cond: { type: "metadata", filter: { key: "file_size", op: "eq", value: 500 } } });
  });
});

/** U-7 ② + P0（日期线格式）：date 快捷与手工日期一律收发 YYYY-MM-DD 字符串 —— 后端只认字符串，
 *  旧 epoch 数字路径已废（本地零点数字会让后端 .as_str() 得 None 而报错）。 */
describe("U-7 日期快捷 · date_condition_wire_format_is_iso_string", () => {
  /** 读单个 metadata leaf 的 filter.value（供断言线格式用）。 */
  function leafValue(expr: QueryExpr | undefined): unknown {
    if (!expr || expr.op !== "leaf" || expr.cond.type !== "metadata") return undefined;
    return expr.cond.filter.value;
  }

  it("gte + 今天 → 写当天 YYYY-MM-DD 字符串（不是 epoch 数字）", () => {
    const now = new Date();
    render(<QueryBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "+ 添加第一个条件" }));
    pickField("拍摄时间");
    fireEvent.change(screen.getByLabelText("日期快捷"), { target: { value: "today" } });
    const expr = useSuperSearchStore.getState().expr;
    const value = leafValue(expr);
    expect(value).toBe(shortcutStartMs("today", now));
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof value).toBe("string");
  });

  it("lte + 本周 → 写本周最后一天 YYYY-MM-DD 字符串（lte 含当天全天）", () => {
    const now = new Date();
    render(<QueryBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "+ 添加第一个条件" }));
    pickField("入库时间");
    fireEvent.change(screen.getByLabelText("条件操作符"), { target: { value: "lte" } });
    fireEvent.change(screen.getByLabelText("日期快捷"), { target: { value: "thisWeek" } });
    const expr = useSuperSearchStore.getState().expr;
    const value = leafValue(expr);
    expect(value).toBe(shortcutEndMs("thisWeek", now));
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof value).toBe("string");
  });

  it("选中后快捷下拉回到自定义，可继续手工改日期（写字符串）", () => {
    render(<QueryBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "+ 添加第一个条件" }));
    pickField("拍摄时间");
    const quick = screen.getByLabelText("日期快捷") as HTMLSelectElement;
    fireEvent.change(quick, { target: { value: "thisMonth" } });
    expect((quick as HTMLSelectElement).value).toBe("");
    const date = screen.getByLabelText("条件值") as HTMLInputElement;
    expect(date.type).toBe("date");
    // 手工改日期会覆盖快捷值
    fireEvent.change(date, { target: { value: "2025-01-01" } });
    expect(useSuperSearchStore.getState().expr).toEqual({ op: "leaf", cond: { type: "metadata", filter: { key: "taken_at", op: "gte", value: "2025-01-01" } } });
  });

  it("date 输入框回显字符串值（旧 epoch 数字也归一为本地日期显示）", () => {
    // 历史持久化数据：epoch 数字仍能打开并回显，不崩溃
    useSuperSearchStore.setState({
      expr: { op: "leaf", cond: { type: "metadata", filter: { key: "taken_at", op: "gte", value: new Date("2025-01-01T00:00:00").getTime() } } },
    });
    render(<QueryBuilder />);
    const date = screen.getByLabelText("条件值") as HTMLInputElement;
    expect(date.type).toBe("date");
    expect(date.value).toBe("2025-01-01");
    // 失焦/再改一次 → 新值变成 ISO 字符串
    fireEvent.change(date, { target: { value: "2025-02-02" } });
    expect(useSuperSearchStore.getState().expr).toEqual({ op: "leaf", cond: { type: "metadata", filter: { key: "taken_at", op: "gte", value: "2025-02-02" } } });
  });
});

/** U-1：字段下拉 → 可搜索 combobox（输入过滤 + ↑↓/Enter/Esc + 点外关闭 + 最近使用 5 置顶） */
describe("U-1 可搜索字段 combobox", () => {
  it("queryBuilder_field_combobox_searchable：输入过滤 + ↑↓ + Enter 选中", () => {
    render(<QueryBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "+ 添加第一个条件" }));
    const combo = screen.getByRole("combobox", { name: "条件字段" }) as HTMLInputElement;
    // 未打开时输入框显示当前字段中文标签（默认 tag → 包含标签）
    expect(combo.value).toBe("包含标签");
    fireEvent.focus(combo);
    fireEvent.change(combo, { target: { value: "时长" } });
    const opts = within(screen.getByRole("listbox", { name: "条件字段列表" })).getAllByRole("option");
    expect(opts).toHaveLength(1);
    expect(opts[0]).toHaveTextContent("视频时长");
    fireEvent.keyDown(combo, { key: "ArrowDown" });
    fireEvent.keyDown(combo, { key: "Enter" });
    // 选中后回填中文标签并关闭列表
    expect(combo.value).toBe("视频时长");
    expect(combo.getAttribute("aria-expanded")).toBe("false");
  });

  it("Esc 关闭并回到当前字段标签；无匹配时显示提示", () => {
    render(<QueryBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "+ 添加第一个条件" }));
    const combo = screen.getByRole("combobox", { name: "条件字段" }) as HTMLInputElement;
    fireEvent.focus(combo);
    fireEvent.change(combo, { target: { value: "不存在的字段" } });
    expect(screen.getByText("没有匹配的字段")).toBeInTheDocument();
    fireEvent.keyDown(combo, { key: "Escape" });
    expect(combo.getAttribute("aria-expanded")).toBe("false");
    expect(combo.value).toBe("包含标签");
  });

  it("最近使用字段置顶（localStorage 5，最新在前，组内去重）", () => {
    localStorage.setItem("qb:recent-fields", JSON.stringify(["width", "iso"]));
    render(<QueryBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "+ 添加第一个条件" }));
    fireEvent.focus(screen.getByRole("combobox", { name: "条件字段" }));
    const listbox = within(screen.getByRole("listbox", { name: "条件字段列表" }));
    const groups = listbox.getAllByRole("group").map((g) => g.getAttribute("aria-label"));
    expect(groups[0]).toBe("最近使用");
    const opts = listbox.getAllByRole("option");
    expect(opts[0]).toHaveTextContent("宽度");
    expect(opts[1]).toHaveTextContent("ISO");
    // 最近使用的 key 已从其分组移除（宽度只出现一次）
    expect(opts.filter((o) => o.textContent === "宽度")).toHaveLength(1);
    expect(opts.filter((o) => o.textContent === "ISO")).toHaveLength(1);
  });

  it("选择字段写入最近使用并持久化（最多 5 个）", () => {
    render(<QueryBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "+ 添加第一个条件" }));
    pickField("文件大小");
    expect(JSON.parse(localStorage.getItem("qb:recent-fields") ?? "[]")).toEqual(["file_size"]);
    pickField("宽度");
    expect(JSON.parse(localStorage.getItem("qb:recent-fields") ?? "[]")).toEqual(["width", "file_size"]);
  });
});

/** U-2：标签多选 → chip + 可搜索面板 + 匹配模式（默认别名） */
describe("U-2 标签 chip 多选", () => {
  const mkTag = (id: number, name: string, facetKey: string, aliases: string[] = []) => ({
    id, name, canonicalName: name, normalizedName: name, facetKey,
    parentId: null, status: "active" as const, isSystem: false, isPreset: false,
    sortOrder: 0, assetCount: 0, totalCount: 0, aliases, path: name, facetEffective: true,
  });

  it("queryBuilder_tag_chip_multiselect：chip 展示选中 + 逐条移除", () => {
    useTagStore.setState({
      tree: [
        { tag: mkTag(1, "海边", "scene"), children: [] },
        { tag: mkTag(2, "人像", "subject", ["肖像"]), children: [] },
      ],
      loading: false, treesByFacet: {}, expanded: new Set(),
    });
    render(<QueryBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "+ 添加第一个条件" }));
    fireEvent.click(screen.getByRole("button", { name: "选择标签" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "海边" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "人像" }));
    // 两个已选 chip
    expect(screen.getByRole("button", { name: "移除 海边" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "移除 人像" })).toBeInTheDocument();
    // 移除「海边」→ 只剩 人像
    fireEvent.click(screen.getByRole("button", { name: "移除 海边" }));
    const expr = useSuperSearchStore.getState().expr;
    if (expr?.op === "leaf" && expr.cond.type === "tag") {
      expect(expr.cond.tagIds).toEqual([2]);
    } else {
      throw new Error("expected single tag leaf");
    }
  });

  it("queryBuilder_term_match_selector：默认别名，切换精确后别名不可命中", () => {
    useTagStore.setState({
      tree: [
        { tag: mkTag(1, "海边", "scene"), children: [] },
        { tag: mkTag(2, "人像", "subject", ["肖像"]), children: [] },
      ],
      loading: false, treesByFacet: {}, expanded: new Set(),
    });
    render(<QueryBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "+ 添加第一个条件" }));
    fireEvent.click(screen.getByRole("button", { name: "选择标签" }));
    const mode = screen.getByLabelText("匹配模式") as HTMLSelectElement;
    expect(mode.value).toBe("alias");
    const search = screen.getByLabelText("搜索标签");
    // 别名默认：搜别名「肖」命中 人像（aliases: ["肖像"]）
    fireEvent.change(search, { target: { value: "肖" } });
    expect(screen.getByRole("checkbox", { name: "人像" })).toBeInTheDocument();
    // 精确：别名不算 → 无匹配提示
    fireEvent.change(mode, { target: { value: "exact" } });
    expect(screen.queryByRole("checkbox", { name: "人像" })).not.toBeInTheDocument();
    expect(screen.getByText("没有匹配的标签")).toBeInTheDocument();
  });

  it("前缀模式：prefix 命中开头；contains 命中任意位置", () => {
    useTagStore.setState({
      tree: [
        { tag: mkTag(1, "海边", "scene"), children: [] },
        { tag: mkTag(2, "人像", "subject"), children: [] },
        { tag: mkTag(3, "海风", "scene"), children: [] },
      ],
      loading: false, treesByFacet: {}, expanded: new Set(),
    });
    render(<QueryBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "+ 添加第一个条件" }));
    fireEvent.click(screen.getByRole("button", { name: "选择标签" }));
    fireEvent.change(screen.getByLabelText("搜索标签"), { target: { value: "海" } });
    // alias（默认）同时命中 海边/海风
    expect(screen.getByRole("checkbox", { name: "海边" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "海风" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("匹配模式"), { target: { value: "prefix" } });
    expect(screen.getByRole("checkbox", { name: "海边" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "海风" })).toBeInTheDocument();
    // contains 命中任意位置：搜「风」只有 海风
    fireEvent.change(screen.getByLabelText("匹配模式"), { target: { value: "contains" } });
    fireEvent.change(screen.getByLabelText("搜索标签"), { target: { value: "风" } });
    expect(screen.getByRole("checkbox", { name: "海风" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "海边" })).not.toBeInTheDocument();
  });
});

/** U-3：前三色色块选择器 —— 单选 eq（+ 占比阈值 min）/ 多选 in；高级 hue/sat/lum 数值输入仍在颜色组。 */
describe("U-3 色块选择器", () => {
  it("queryBuilder_color_swatch_picker：色块单选 + 阈值滑块 → eq 带 min；多选 → in；撤选回 eq", () => {
    render(<QueryBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "+ 添加第一个条件" }));
    pickField("前三色包含");
    // 单选「红」→ eq 红（无阈值）
    fireEvent.click(screen.getByRole("button", { name: "红" }));
    let expr = useSuperSearchStore.getState().expr;
    expect(expr).toEqual({ op: "leaf", cond: { type: "metadata", filter: { key: "palette_top3", op: "eq", value: "红" } } });
    // 滑块出现 → 拖到 50 → min=0.5
    const slider = screen.getByLabelText("占比阈值") as HTMLInputElement;
    expect(slider.value).toBe("0");
    fireEvent.change(slider, { target: { value: "50" } });
    expr = useSuperSearchStore.getState().expr;
    if (expr?.op === "leaf" && expr.cond.type === "metadata") {
      expect(expr.cond.filter).toMatchObject({ key: "palette_top3", op: "eq", value: "红", min: 0.5 });
    } else {
      throw new Error("expected palette leaf");
    }
    // 再选「蓝」→ 多选转 in（阈值不适用）
    fireEvent.click(screen.getByRole("button", { name: "蓝" }));
    expr = useSuperSearchStore.getState().expr;
    if (expr?.op === "leaf" && expr.cond.type === "metadata") {
      expect(expr.cond.filter).toMatchObject({ key: "palette_top3", op: "in", values: ["红", "蓝"] });
      expect((expr.cond.filter as { min?: number }).min).toBeUndefined();
    } else {
      throw new Error("expected palette leaf");
    }
    // 移除「红」→ 单蓝 eq 无阈值
    fireEvent.click(screen.getByRole("button", { name: "红" }));
    expr = useSuperSearchStore.getState().expr;
    if (expr?.op === "leaf" && expr.cond.type === "metadata") {
      expect(expr.cond.filter).toMatchObject({ key: "palette_top3", op: "eq", value: "蓝" });
    } else {
      throw new Error("expected palette leaf");
    }
  });
});

/** U-4：一层 OR/AND 嵌套 → 可展开的只读树形视图（不再是「复杂条件（N 项）」一句话）。 */
describe("U-4 一层嵌套只读树形视图", () => {
  it("queryBuilder_one_level_nesting：展开后按层显示 OR 组与叶子；只读；追加条件仍 AND 合并", () => {
    // A 且 (B 或 C)：一层 OR 嵌套
    const expr: QueryExpr = {
      op: "and",
      children: [
        { op: "leaf", cond: { type: "search", value: "海边", scope: "all" } },
        {
          op: "or",
          children: [
            { op: "leaf", cond: { type: "tag", facetKey: "subject", tagIds: [1], mode: "any", includeDescendants: false } },
            { op: "leaf", cond: { type: "tag", facetKey: "subject", tagIds: [2], mode: "any", includeDescendants: false } },
          ],
        },
      ],
    };
    useSuperSearchStore.setState({
      expr,
      resolvedTags: [
        { facetKey: "subject", text: "人物", tagId: 1, path: "" },
        { facetKey: "subject", text: "女孩", tagId: 2, path: "" },
      ],
    });
    render(<QueryBuilder />);
    // 摘要可见且默认收起
    expect(screen.getByText(/复杂条件（3 项）/)).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: /展开只读树形查看/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("海边")).not.toBeInTheDocument();
    // 展开 → 树形：根叶子 + OR 组行 + 组内叶子（tag 名称经 resolvedTags 解析）
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/海边/)).toBeInTheDocument();
    expect(screen.getAllByText(/或者/)).toHaveLength(1);
    expect(screen.getByText(/标签：人物/)).toBeInTheDocument();
    expect(screen.getByText(/标签：女孩/)).toBeInTheDocument();
    // 只读：不渲染可编辑输入
    expect(screen.queryByPlaceholderText("输入关键词")).not.toBeInTheDocument();
    // 追加条件仍与整棵现有树 AND 合并（可折叠回摘要后再加）
    fireEvent.click(screen.getByRole("button", { name: "+ 添加第一个条件" }));
    pickField("关键词");
    const input = screen.getByPlaceholderText("输入关键词");
    fireEvent.change(input, { target: { value: "夜景" } });
    fireEvent.blur(input);
    const merged = useSuperSearchStore.getState().expr;
    expect(merged?.op).toBe("and");
    const children = merged && merged.op === "and" ? merged.children : [];
    expect(children).toContainEqual({ op: "leaf", cond: { type: "search", value: "夜景" } });
    const orChild = children.find((c) => c.op === "or") as QueryExpr | undefined;
    expect(orChild).toBeTruthy();
  });
});

/** U-5：加分项（should）区 —— 渲染、至少满足下拉、三档权重。加分项直写 store.plan.should，expr（filter）单源保持。 */
describe("U-5 加分项区", () => {
  const seedShouldPlan = (weights: number[], min: number) => {
    const baseExpr: QueryExpr = { op: "leaf", cond: { type: "search", value: "海边" } };
    const rows = weights.map((w, i) => ({ id: i + 5, name: ["蓝天", "夜景", "女孩"][i] ?? `加分${i}`, weight: w }));
    const plan: SearchPlanV3 = {
      planSchemaVersion: 3, normalizationVersion: 1, compilerVersion: 1,
      filter: baseExpr, mustNot: null,
      should: rows.map((r) => ({ cond: { type: "tag", facetKey: "scene", tagIds: [r.id], mode: "any", includeDescendants: false }, weight: r.weight, label: r.name })),
      minimumShouldMatch: min,
      retrievers: { retrievers: [] },
      ranking: { type: "field", key: "created_at", dir: "desc" },
    };
    useSuperSearchStore.setState({
      expr: baseExpr,
      plan,
      resolvedTags: rows.map((r) => ({ facetKey: "scene", text: r.name, tagId: r.id, path: "" })),
    });
  };

  it("queryBuilder_should_section_renders：优先满足区（plan.should）显示行编辑 + 空态引导", () => {
    seedShouldPlan([1, 1, 1], 1);
    render(<QueryBuilder />);
    expect(screen.getByText("优先满足")).toBeInTheDocument();
    // 三条加分项各渲染一个值编辑区（chips 显示标签名）
    expect(screen.getByText(/蓝天/)).toBeInTheDocument();
    expect(screen.getByText(/夜景/)).toBeInTheDocument();
    expect(screen.getByText(/女孩/)).toBeInTheDocument();
    // 权重下拉数量与加分项一致
    expect(screen.getAllByLabelText("加分权重")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "＋ 添加优先条件" })).toBeInTheDocument();
  });

  it("queryBuilder_min_should_match_dropdown：移入〔高级设置〕折叠区，展开后下拉 0..N（含全部），变更写入 plan", () => {
    seedShouldPlan([1, 1, 1], 2);
    render(<QueryBuilder />);
    // §3.4：至少满足 N 项默认收起（防误读成「满足几项加几分」），点开高级设置才出现
    expect(screen.queryByLabelText("至少满足")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "高级设置" }));
    const min = screen.getByLabelText("至少满足") as HTMLSelectElement;
    expect(min.value).toBe("2");
    const optionTexts = Array.from(min.options).map((o) => o.textContent ?? "");
    expect(optionTexts).toContain("0（不限）");
    expect(optionTexts).toContain("3（全部）");
    fireEvent.change(min, { target: { value: "0" } });
    expect(useSuperSearchStore.getState().plan?.minimumShouldMatch).toBe(0);
    expect((screen.getByLabelText("至少满足") as HTMLSelectElement).value).toBe("0");
  });

  it("queryBuilder_weight_three_tiers：三档权重下拉 0.5/1.0/2.0，切换写回 should", () => {
    seedShouldPlan([0.5, 1, 2], 1);
    render(<QueryBuilder />);
    const weightSelects = screen.getAllByLabelText("加分权重") as HTMLSelectElement[];
    expect(weightSelects.map((w) => w.value)).toEqual(["0.5", "1", "2"]);
    const labels = Array.from(weightSelects[0].options).map((o) => o.textContent ?? "");
    expect(labels).toEqual(["轻微偏好", "一般偏好", "强烈偏好"]);
    fireEvent.change(weightSelects[0], { target: { value: "2" } });
    const should = useSuperSearchStore.getState().plan?.should;
    expect(should?.[0].weight).toBe(2);
  });

  it("空 plan 时新增加分项 → store 从当前 expr 建 plan（filter 镜像，should 一条、默认权重 1）", () => {
    useSuperSearchStore.setState({
      expr: { op: "leaf", cond: { type: "search", value: "海边" } },
      plan: null,
    });
    render(<QueryBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "＋ 添加优先条件" }));
    const plan = useSuperSearchStore.getState().plan;
    expect(plan?.should).toHaveLength(1);
    expect(plan?.should?.[0].weight).toBe(1);
    expect(plan?.filter).toEqual({ op: "leaf", cond: { type: "search", value: "海边" } });
  });
});

/** U-6：C-2 四指标诊断展示 —— diagnose_search_plan_cmd 结果映射到行级注记。 */
describe("U-6 四指标诊断", () => {
  it("queryBuilder_diagnostics_marks_zeroing_leaf：delta>0 且 result=0 标红归零；self_count=0 标注单独无匹配", async () => {
    const { diagnoseSearchPlan } = await import("@/api/superSearch");
    const expr: QueryExpr = {
      op: "and",
      children: [
        { op: "leaf", cond: { type: "search", value: "海边" } },
        { op: "leaf", cond: { type: "search", value: "霓虹" } },
      ],
    };
    useSuperSearchStore.setState({ expr, plan: null });
    useSuperSearchStore.setState({ planRevision: 0 });
    vi.mocked(diagnoseSearchPlan).mockResolvedValue({
      leaves: [
        { zone: "filter", path: [0], planRevision: 0, label: "海边", selfCount: 106, resultCount: 0, countWithoutLeaf: 106, delta: 106 },
        { zone: "filter", path: [1], planRevision: 0, label: "霓虹", selfCount: 0, resultCount: 10, countWithoutLeaf: 15, delta: 5 },
      ],
      should: [],
      warnings: [],
    });
    render(<QueryBuilder />);
    // 诊断经 promise 微任务落 UI；纯微任务轮询（组件/测试不使用真实定时器，避免调度器挂起）
    let found = false;
    for (let i = 0; i < 200 && !found; i += 1) {
      found = screen.queryByText(/这个条件把结果砍到 0/) !== null;
      if (!found) await Promise.resolve();
    }
    expect(found).toBe(true);
    // 第二行：−5（delta）+ 单独就没有匹配项（self_count=0）
    expect(screen.getByText(/−5/)).toBeInTheDocument();
    expect(screen.getAllByText(/单独就没有匹配项/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/−106/)).not.toBeInTheDocument(); // 归零行走红色文案，不再重复 −delta
  });
});

/** §3.4/§3.8：排除区（plan.mustNot）—— OR 平铺、无行内「不是」下拉、直写 setPlanMustNot。 */
describe("排除区（mustNot）", () => {
  const seedPlan = (mustNot: QueryExpr | null, filter: QueryExpr = { op: "leaf", cond: { type: "search", value: "海边" } }) => {
    const plan: SearchPlanV3 = {
      planSchemaVersion: 3, normalizationVersion: 1, compilerVersion: 1,
      filter, mustNot,
      should: [],
      minimumShouldMatch: 0,
      retrievers: { retrievers: [] },
      ranking: { type: "field", key: "created_at", dir: "desc" },
    };
    useSuperSearchStore.setState({ expr: filter, plan, planRevision: 0, resolvedTags: [] });
    return plan;
  };

  it("queryBuilder_exclusion_zone_renders_plan_must_not：排除区渲染 OR 行，行内无「是/不是」下拉", async () => {
    const mustNot: QueryExpr = {
      op: "or",
      children: [
        { op: "leaf", cond: { type: "search", value: "夜景" } },
        { op: "leaf", cond: { type: "assetType", value: "video" } },
      ],
    };
    seedPlan(mustNot);
    render(<QueryBuilder />);
    expect(screen.getByText("排除")).toBeInTheDocument();
    expect(screen.getByText("命中任一条就不显示")).toBeInTheDocument();
    const zone = document.getElementById("qb-zone-mustnot");
    expect(zone).not.toBeNull();
    // 行来自 useEffect（mustNotSig → exRows），等一拍再断言
    await waitFor(() => expect(within(zone as HTMLElement).getByDisplayValue("夜景")).toBeInTheDocument());
    // 两行条件（search 输入回显 + assetType 下拉选中 video）
    expect((within(zone as HTMLElement).getByRole("combobox", { name: "条件值" }) as HTMLSelectElement).value).toBe("video");
    // §3.4/§3.8：行内不再是/不是下拉（否定由排除区承担）——非元数据行没有「条件操作符」combobox
    expect(within(zone as HTMLElement).queryAllByRole("combobox", { name: "条件操作符" })).toHaveLength(0);
  });

  it("queryBuilder_exclusion_zone_edit_writes_plan_must_not：删除 OR 行收敛为单叶；清空后必须区保留", async () => {
    const mustNot: QueryExpr = {
      op: "or",
      children: [
        { op: "leaf", cond: { type: "search", value: "夜景" } },
        { op: "leaf", cond: { type: "search", value: "噪点" } },
      ],
    };
    seedPlan(mustNot);
    render(<QueryBuilder />);
    const zone = document.getElementById("qb-zone-mustnot") as HTMLElement;
    await waitFor(() => expect(within(zone).getAllByRole("button", { name: "删除条件" })).toHaveLength(2));
    // 删除第一行（夜景）→ 收敛为单叶
    fireEvent.click(within(zone).getAllByRole("button", { name: "删除条件" })[0]);
    let plan = useSuperSearchStore.getState().plan;
    expect(plan?.mustNot).toEqual({ op: "leaf", cond: { type: "search", value: "噪点" } });
    // 删到空 → mustNot 置空；filter（必须区）原样保留（不变式 3：三区全空才清 plan）
    fireEvent.click(within(zone).getAllByRole("button", { name: "删除条件" })[0]);
    plan = useSuperSearchStore.getState().plan;
    expect(plan?.mustNot).toBeNull();
    expect(plan?.filter).toEqual({ op: "leaf", cond: { type: "search", value: "海边" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "+ 添加第一个排除条件" })).toBeInTheDocument());
  });

  it("queryBuilder_exclusion_zone_add_row：＋ 添加排除条件 → 草稿行出现，未完成不写回 plan", async () => {
    seedPlan(null);
    render(<QueryBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "+ 添加第一个排除条件" }));
    // 空标签草稿行：行在 UI，但未完成条件不进 mustNot
    expect(useSuperSearchStore.getState().plan?.mustNot).toBeNull();
    const zone = document.getElementById("qb-zone-mustnot") as HTMLElement;
    await waitFor(() => expect(within(zone).getByRole("button", { name: "＋ 添加排除条件" })).toBeInTheDocument());
    expect(within(zone).getAllByRole("combobox", { name: "条件字段" })).toHaveLength(1);
  });

  it("queryBuilder_exclusion_zone_diag：排除行诊断带 zone=mustNot，归零标红显示在排除区", async () => {
    const { diagnoseSearchPlan } = await import("@/api/superSearch");
    const mustNot: QueryExpr = {
      op: "or",
      children: [
        { op: "leaf", cond: { type: "search", value: "夜景" } },
        { op: "leaf", cond: { type: "search", value: "霓虹" } },
      ],
    };
    seedPlan(mustNot);
    vi.mocked(diagnoseSearchPlan).mockResolvedValue({
      leaves: [
        { zone: "filter", path: [], planRevision: 0, label: "海边", selfCount: 100, resultCount: 0, countWithoutLeaf: 100, delta: 100 },
        { zone: "mustNot", path: [1], planRevision: 0, label: "霓虹", selfCount: 40, resultCount: 0, countWithoutLeaf: 60, delta: 60 },
      ],
      should: [],
      warnings: [],
    });
    render(<QueryBuilder />);
    const zone = document.getElementById("qb-zone-mustnot") as HTMLElement;
    let found = false;
    for (let i = 0; i < 200 && !found; i += 1) {
      found = within(zone).queryByText(/这个条件把结果砍到 0/) !== null;
      if (!found) await Promise.resolve();
    }
    expect(found).toBe(true);
  });
});

/** §3.5：ShouldClause.evidence 原文回显（AI 判断可逐条改判）。 */
describe("优先满足 evidence 回显", () => {
  it("queryBuilder_should_evidence_echo：should 行下方显示「evidence」原文", () => {
    const filter: QueryExpr = { op: "leaf", cond: { type: "search", value: "海边" } };
    const plan: SearchPlanV3 = {
      planSchemaVersion: 3, normalizationVersion: 1, compilerVersion: 1,
      filter, mustNot: null,
      should: [
        { cond: { type: "tag", facetKey: "scene", tagIds: [5], mode: "any", includeDescendants: false }, weight: 1, label: "户外", evidence: "最好是户外" },
      ],
      minimumShouldMatch: 0,
      retrievers: { retrievers: [] },
      ranking: { type: "field", key: "created_at", dir: "desc" },
    };
    useSuperSearchStore.setState({ expr: filter, plan, resolvedTags: [{ facetKey: "scene", text: "户外", tagId: 5, path: "" }] });
    render(<QueryBuilder />);
    expect(screen.getByText("「最好是户外」")).toBeInTheDocument();
  });
});

/** Phase 4（§5.3/5.4/5.5）：NumericDomain 单源驱动的输入控件。 */
describe("Phase 4 · 数值输入统一", () => {
  const domainOf = (key: string, extra: Partial<NumericDomain>): NumericDomain => ({
    key, unit: "raw", min: null, max: null, step: 1, decimals: 0, presets: [], circular: false,
    suspiciousBelow: null, allowedOps: ["eq", "gt", "gte", "lt", "lte", "between"], ...extra,
  } as NumericDomain);
  function openField(label: string) {
    render(<QueryBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "+ 添加第一个条件" }));
    pickField(label);
  }
  function leafFilter(): any {
    const e = useSuperSearchStore.getState().expr;
    if (!e || e.op !== "leaf" || e.cond.type !== "metadata") return undefined;
    return e.cond.filter;
  }

  it("valueInput_respects_domain_bounds：数值输入 clamp 到 NumericDomain 的 min/max", () => {
    useNumericDomainStore.setState({ domains: [domainOf("dominant_sat", { unit: "percent", min: 0, max: 100, step: 1 })], loaded: true, loading: false });
    openField("主色饱和度（0-100）");
    const num = screen.getByRole("spinbutton", { name: "数值输入" });
    fireEvent.change(num, { target: { value: "150" } });
    const f = leafFilter();
    expect(f?.key).toBe("dominant_sat");
    expect(f?.value).toBe(100); // 越界 150 被 clamp 回 100
  });

  it("rating_star_picker_writes_number：评级 eq 用 0–5 星选，点击写数值", () => {
    useNumericDomainStore.setState({ domains: [domainOf("rating", { unit: "stars", min: 0, max: 5, step: 1 })], loaded: true, loading: false });
    openField("评级");
    fireEvent.click(screen.getByRole("radio", { name: "4 星" }));
    const f = leafFilter();
    expect(f?.key).toBe("rating");
    expect(f?.value).toBe(4);
    fireEvent.click(screen.getByRole("radio", { name: "4 星" })); // 点当前星清回 0（未评级）
    expect(leafFilter()?.value).toBe(0);
  });

  it("between_rejects_inverted_range_except_circular：非环形倒置不进条件并提示；色相跨 0° 合法", () => {
    useNumericDomainStore.setState({ domains: [
      domainOf("dominant_sat", { unit: "percent", min: 0, max: 100 }),
      domainOf("dominant_hue", { unit: "degrees", min: 0, max: 359, circular: true }),
    ], loaded: true, loading: false });
    // 非环形：下限 > 上限 → 拒绝（不进 expr）
    openField("主色饱和度（0-100）");
    fireEvent.change(screen.getByLabelText("条件操作符"), { target: { value: "between" } });
    const [lo, hi] = screen.getAllByRole("spinbutton", { name: "条件值" });
    fireEvent.change(lo, { target: { value: "80" } }); fireEvent.blur(lo);
    fireEvent.change(hi, { target: { value: "20" } }); fireEvent.blur(hi);
    expect(leafFilter()).toBeUndefined();
    expect(screen.getByText(/范围下限不能大于上限/)).toBeInTheDocument();
    // 环形（色相跨 0°）：345–15 合法
    useSuperSearchStore.setState({ expr: undefined, plan: null });
    openField("主色色相（0-359，可跨 0°）");
    fireEvent.change(screen.getByLabelText("条件操作符"), { target: { value: "between" } });
    const [hlo, hhi] = screen.getAllByRole("spinbutton", { name: "条件值" });
    fireEvent.change(hlo, { target: { value: "345" } }); fireEvent.blur(hlo);
    fireEvent.change(hhi, { target: { value: "15" } }); fireEvent.blur(hhi);
    const f = leafFilter();
    expect(f?.key).toBe("dominant_hue");
    expect(f?.min).toBe(345);
    expect(f?.max).toBe(15);
  });

  it("size_unit_shared_across_between：file_size 区间两侧共用一个单位下拉，切换单位换算一致", () => {
    openField("文件大小");
    fireEvent.change(screen.getByLabelText("条件操作符"), { target: { value: "between" } });
    const units = screen.getAllByLabelText("数值单位");
    expect(units).toHaveLength(1); // 共享单位，不是每侧一个
    fireEvent.change(units[0], { target: { value: "KB" } });
    const [lo, hi] = screen.getAllByRole("spinbutton", { name: /范围/ });
    fireEvent.change(lo, { target: { value: "5" } }); fireEvent.blur(lo);
    fireEvent.change(hi, { target: { value: "10" } }); fireEvent.blur(hi);
    const f = leafFilter();
    expect(f?.min).toBe(5120);
    expect(f?.max).toBe(10240);
    expect(f?.unit).toBe("KB");
  });

  it("size_unit_survives_external_expr_change：单位进 filter，外部改写数值后单位不丢", async () => {
    openField("文件大小");
    fireEvent.change(screen.getByLabelText("数值单位"), { target: { value: "KB" } });
    const input = screen.getByRole("spinbutton", { name: "条件值" });
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.blur(input);
    expect(leafFilter()?.value).toBe(5120);
    // 外部（换源/AI 合并）改写数值但保留 unit：重渲染后仍按 KB 显示
    useSuperSearchStore.setState({ expr: { op: "leaf", cond: { type: "metadata", filter: { key: "file_size", op: "eq", value: 10240, unit: "KB" as const } } } });
    await waitFor(() => {
      expect(useSuperSearchStore.getState().expr).toEqual({ op: "leaf", cond: { type: "metadata", filter: { key: "file_size", op: "eq", value: 10240, unit: "KB" } } });
    });
    expect((screen.getByLabelText("数值单位") as HTMLSelectElement).value).toBe("KB");
    expect((await screen.findByDisplayValue("10"))).toBeInTheDocument();
  });

  it("enum_value_dropdown_shows_counts：file_ext 的 eq 候选值带命中数", () => {
    useMetadataStore.setState({
      facets: [{ key: "file_ext", displayName: "文件格式", description: "", items: [
        { value: "jpg", label: "JPG", count: 205 },
        { value: "png", label: "PNG", count: 42 },
      ] }],
      loading: false, loaded: true,
    });
    openField("文件格式");
    const select = screen.getByLabelText("条件值") as HTMLSelectElement;
    const opts = Array.from(select.options).map((o) => o.textContent);
    expect(opts).toContain("JPG（205）");
    fireEvent.change(select, { target: { value: "jpg" } });
    expect(leafFilter()?.value).toBe("jpg");
  });
});

// ═══════════════ Phase 3-6：行尾「⋯ 更多」菜单 —— 移到其他区 ═══════════════

describe("三区移动（MoveMenu）", () => {
  it("queryBuilder_move_condition_between_zones：必须区行 → 移到「排除」后 plan.mustNot 含该叶、filter 收敛为剩余条件", async () => {
    const leafA: QueryExpr = { op: "leaf", cond: { type: "untagged" } };
    const leafB: QueryExpr = { op: "leaf", cond: { type: "assetType", value: "image" } };
    const filter: QueryExpr = { op: "and", children: [leafA, leafB] };
    useSuperSearchStore.setState({
      plan: {
        planSchemaVersion: 3, normalizationVersion: 1, compilerVersion: 1,
        filter, mustNot: null, should: [], minimumShouldMatch: 0,
        retrievers: { retrievers: [] }, ranking: { type: "field", key: "created_at", dir: "desc" },
      },
      expr: filter,
    });
    render(<QueryBuilder />);

    // 第 0 行（未打标）→ ⋯ → 移到「排除」
    const moreButtons = screen.getAllByRole("button", { name: "更多操作" });
    fireEvent.click(moreButtons[0]);
    fireEvent.click(screen.getByRole("button", { name: "移到排除" }));

    const { plan } = useSuperSearchStore.getState();
    expect(plan?.mustNot).toEqual({ op: "leaf", cond: { type: "untagged" } });
    expect(plan?.filter).toEqual(leafB); // filter 收敛为剩余单叶
    // 排除区立即出现该行（OR 平铺）
    await waitFor(() => {
      const rows = screen.getAllByRole("combobox", { name: "条件字段" });
      expect(rows.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("queryBuilder_move_should_to_must_not：优先区行 → 移到「排除」；should 收敛且 min 自动下降", () => {
    const cond: LeafCond = { type: "search", value: "蓝天" };
    useSuperSearchStore.setState({
      plan: {
        planSchemaVersion: 3, normalizationVersion: 1, compilerVersion: 1,
        filter: null, mustNot: null,
        should: [{ cond, weight: 1, label: "" }],
        minimumShouldMatch: 1,
        retrievers: { retrievers: [] }, ranking: { type: "field", key: "created_at", dir: "desc" },
      },
    });
    render(<QueryBuilder />);
    const moreButtons = screen.getAllByRole("button", { name: "更多操作" });
    fireEvent.click(moreButtons[0]);
    fireEvent.click(screen.getByRole("button", { name: "移到排除" }));
    const { plan } = useSuperSearchStore.getState();
    expect(plan?.should).toEqual([]);
    expect(plan?.minimumShouldMatch).toBe(0); // should 清空 → min 收敛为 0
    expect(plan?.mustNot).toEqual({ op: "leaf", cond: { type: "search", value: "蓝天" } });
  });
});

// ═══════════════ Phase 7-8：QueryBuilder 数值分面条件行 ═══════════════

describe("数值分面条件行（facetNumber）", () => {
  const facetDomain: NumericDomain = {
    key: "facet:people_count",
    label: "人数",
    unit: "custom",
    unitLabel: "人",
    min: 0,
    max: 50,
    step: 1,
    decimals: 0,
    presets: [],
    circular: false,
    allowedOps: ["eq", "gt", "gte", "lt", "lte", "between"],
  };

  function setFacetDomain() {
    useNumericDomainStore.setState({ domains: [facetDomain], loading: false, loaded: true });
  }

  it("queryBuilder_facet_number_field_in_dropdown：字段下拉出现「数值分面」组（动态 domain）", () => {
    setFacetDomain();
    render(<QueryBuilder />);
    fireEvent.click(screen.getByText("+ 添加第一个条件"));
    fireEvent.focus(screen.getAllByRole("combobox", { name: "条件字段" })[0]);
    expect(screen.getByRole("group", { name: "数值分面" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "人数" })).toBeTruthy();
  });

  it("queryBuilder_facet_number_row_writes_leaf：选「人数」→ 默认 ≥ 下限；改值为 5 → expr 生成 facetNumber 叶", async () => {
    setFacetDomain();
    render(<QueryBuilder />);
    fireEvent.click(screen.getByText("+ 添加第一个条件"));
    pickField("人数");
    // 默认 op = gte、默认值 = domain.min（0）→ 已是完整条件
    await waitFor(() => {
      const expr = useSuperSearchStore.getState().expr;
      expect(expr).toEqual({ op: "leaf", cond: { type: "facetNumber", facetKey: "people_count", op: "gte", value: 0, maxValue: null } });
    });
    // 改值 5
    const valueInput = screen.getAllByLabelText("条件值")[0];
    fireEvent.change(valueInput, { target: { value: "5" } });
    fireEvent.blur(valueInput);
    await waitFor(() => {
      const expr = useSuperSearchStore.getState().expr;
      expect((expr as { op: string; cond?: { value?: number } }).cond?.value).toBe(5);
    });
  });

  it("queryBuilder_facet_number_between：切「介于」→ 两输入共用单位；倒置不进条件", () => {
    setFacetDomain();
    render(<QueryBuilder />);
    fireEvent.click(screen.getByText("+ 添加第一个条件"));
    pickField("人数");
    const opSelect = screen.getAllByLabelText("条件操作符")[0] as HTMLSelectElement;
    expect(opSelect.value).toBe("gte");
    fireEvent.change(opSelect, { target: { value: "between" } });
    const expr = useSuperSearchStore.getState().expr;
    const cond = (expr as { op: string; cond?: { op?: string; maxValue?: number } }).cond;
    expect(cond?.op).toBe("between");
    expect(cond?.maxValue).toBe(1); // 切 between 自动补默认上界（下限 + 步进）
    // 倒置：min > max → 条件不完整，不写进 expr
    const valueInput = screen.getAllByLabelText("条件值")[0];
    fireEvent.change(valueInput, { target: { value: "30" } });
    fireEvent.blur(valueInput);
    const after = useSuperSearchStore.getState().expr;
    // 倒置（30 > 1）→ 条件不完整 → 整个 expr 不写（未完成等待补全）
    expect(after).toBeUndefined();
  });
});
