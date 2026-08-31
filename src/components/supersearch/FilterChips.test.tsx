/** FilterChips（FB5-05 §9.6.1）：expr 为唯一条件源——
 *  - chips 递归遍历 expr：AND 显示「同时满足」，OR 根按组「任一组 N」，NOT 叶「排除：…」；
 *  - 删除 chip 走 store.removeExprAtPath（只摘除该节点），不走 setQuery；
 *  - 排序 chip 独立 setSort；清除全部走 clearConditions；
 *  - 无 expr 时（纯手动链路）退回扁平 query 渲染。 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import FilterChips from "@/components/supersearch/FilterChips";
import { useSuperSearchStore } from "@/stores/superSearchStore";
import type { QueryExpr } from "@/types/queryExpr";

const tagLeaf = (facetKey: string, tagIds: number[]): QueryExpr => ({
  op: "leaf",
  cond: { type: "tag", facetKey, tagIds, mode: "any", includeDescendants: true },
});

const searchLeaf = (value: string, scope: "all" | "content" | "fileName" = "all"): QueryExpr => ({
  op: "leaf",
  cond: { type: "search", value, scope },
});

function setExprState(expr: QueryExpr | undefined, resolvedTags: { facetKey: string; text: string; tagId: number; path?: string }[] = []) {
  useSuperSearchStore.setState({
    expr,
    resolvedTags: resolvedTags.map((t) => ({ ...t, path: t.path ?? "" })),
    query: useSuperSearchStore.getState().query,
    aiExplanation: null,
    warnings: [],
  });
}

describe("FilterChips（FB5-05 §9.6.1 expr 驱动）", () => {
  it("AND 树显示可读标签 chips：主体：建筑 + 色彩：红色", () => {
    setExprState(
      { op: "and", children: [tagLeaf("subject", [1]), tagLeaf("color", [2])] },
      [
        { facetKey: "subject", text: "建筑", tagId: 1 },
        { facetKey: "color", text: "红色", tagId: 2 },
      ],
    );
    render(<FilterChips />);
    expect(screen.getByText("主体/对象：建筑")).toBeInTheDocument();
    expect(screen.getByText("色彩：红色")).toBeInTheDocument();
  });

  it("OR 根按组显示「任一组 1 / 任一组 2」", () => {
    setExprState({
      op: "or",
      children: [
        { op: "and", children: [tagLeaf("lighting", [1]), tagLeaf("subject", [2])] },
        { op: "and", children: [tagLeaf("lighting", [3]), tagLeaf("scene", [4])] },
      ],
    }, [
      { facetKey: "lighting", text: "夜间", tagId: 1 },
      { facetKey: "subject", text: "树", tagId: 2 },
      { facetKey: "lighting", text: "白天", tagId: 3 },
      { facetKey: "scene", text: "建筑", tagId: 4 },
    ]);
    render(<FilterChips />);
    expect(screen.getAllByText("任一组 1").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("任一组 2").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/夜间|树|白天|建筑/).length).toBeGreaterThanOrEqual(4);
  });

  it("NOT 叶显示「排除：…」", () => {
    setExprState({ op: "not", child: tagLeaf("lighting", [5]) }, [
      { facetKey: "lighting", text: "夜景", tagId: 5 },
    ]);
    render(<FilterChips />);
    expect(screen.getByText("排除：夜景")).toBeInTheDocument();
  });

  it("content 范围搜索 leaf 显示「内容：…」（§9.4）", () => {
    setExprState(searchLeaf("银杏树", "content"));
    render(<FilterChips />);
    expect(screen.getByText("内容：银杏树")).toBeInTheDocument();
  });

  it("删除 chip 只摘除该 expr 节点（removeExprAtPath），保留其余条件", () => {
    setExprState(
      { op: "and", children: [tagLeaf("subject", [1]), tagLeaf("color", [2])] },
      [
        { facetKey: "subject", text: "建筑", tagId: 1 },
        { facetKey: "color", text: "红色", tagId: 2 },
      ],
    );
    render(<FilterChips />);
    fireEvent.click(screen.getByRole("button", { name: "取消 色彩：红色" }));
    const st = useSuperSearchStore.getState();
    expect(st.expr).toEqual(tagLeaf("subject", [1]));
    // 剩余名称映射保留
    expect(st.resolvedTags.map((t) => t.tagId)).toEqual([1]);
  });

  it("删除 NOT 叶后 expr 清空（无剩余条件）", () => {
    setExprState({ op: "not", child: tagLeaf("lighting", [5]) }, [
      { facetKey: "lighting", text: "夜景", tagId: 5 },
    ]);
    render(<FilterChips />);
    fireEvent.click(screen.getByRole("button", { name: "取消 排除：夜景" }));
    expect(useSuperSearchStore.getState().expr).toBeUndefined();
  });

  it("未知 tagId 退回「标签#id」", () => {
    setExprState(tagLeaf("custom", [99]));
    render(<FilterChips />);
    expect(screen.getByText("自定义：标签#99")).toBeInTheDocument();
  });

  it("排序 chip 独立：调用 setSort（不碰 expr）", () => {
    useSuperSearchStore.setState({ query: { ...useSuperSearchStore.getState().query, sortBy: "size", sortDir: "desc" } });
    setExprState(tagLeaf("subject", [1]));
    render(<FilterChips />);
    fireEvent.click(screen.getByRole("button", { name: "取消 排序：size desc" }));
    const st = useSuperSearchStore.getState();
    expect(st.query.sortBy).toBe("created_at");
    expect(st.expr).toEqual(tagLeaf("subject", [1]));
    expect(st.query.sortBy).toBe("created_at");
  });

  it("清除全部调用 clearConditions：expr 与扁平筛选同时清空", () => {
    useSuperSearchStore.setState({ query: { ...useSuperSearchStore.getState().query, search: "海边" } });
    setExprState({ op: "and", children: [searchLeaf("海边"), tagLeaf("subject", [1])] });
    render(<FilterChips />);
    fireEvent.click(screen.getByRole("button", { name: "清除全部" }));
    const st = useSuperSearchStore.getState();
    expect(st.expr).toBeUndefined();
    expect(st.query.search).toBe("");
  });

  it("无 expr 时（纯手动链路）退回扁平 query 渲染，删除仍可用", () => {
    setExprState(undefined);
    useSuperSearchStore.setState({
      query: { ...useSuperSearchStore.getState().query, search: "海边" },
    });
    render(<FilterChips />);
    expect(screen.getByText("关键词：海边")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消 关键词：海边" }));
    expect(useSuperSearchStore.getState().query.search).toBe("");
  });
});
