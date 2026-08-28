/** FilterChips §11.6（FB-05）：AI 解析后可读 chips——「主体：建筑 × 色彩：红色 × 关系：全部」；
 *  标签名取自 resolvedTags；删除 chip 改 query 不重新调 AI。 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import FilterChips from "@/components/supersearch/FilterChips";
import { useSuperSearchStore } from "@/stores/superSearchStore";
import type { ResolvedSearchQuery } from "@/types/asset";
import type { ResolvedTag } from "@/types/superSearch";

function resetStore(query: Partial<ResolvedSearchQuery>, resolvedTags: ResolvedTag[] = [], relation: "and" | "or" = "and") {
  const cur = useSuperSearchStore.getState().query;
  useSuperSearchStore.setState({
    query: { ...cur, ...query },
    resolvedTags,
    relation,
    expr: undefined,
    aiExplanation: null,
    warnings: [],
  });
}

describe("FilterChips §11.6 可读标签", () => {
  it("AI 解析「红色建筑」后显示 主体：建筑 × 色彩：红色 × 关系：全部", () => {
    resetStore(
      {
        facetFilters: [
          { facetKey: "subject", tagIds: [1], mode: "any", includeDescendants: true },
          { facetKey: "color", tagIds: [2], mode: "any", includeDescendants: true },
        ],
      },
      [
        { facetKey: "subject", text: "建筑", tagId: 1, path: "" },
        { facetKey: "color", text: "红色", tagId: 2, path: "" },
      ],
      "and",
    );
    render(<FilterChips />);
    expect(screen.getByText("主体/对象：建筑")).toBeInTheDocument();
    expect(screen.getByText("色彩：红色")).toBeInTheDocument();
    expect(screen.getByText("条件（全部）")).toBeInTheDocument();
  });

  it("关系为 or 时显示「任 一」", () => {
    useSuperSearchStore.setState({
      query: { ...useSuperSearchStore.getState().query, facetFilters: [{ facetKey: "subject", tagIds: [1], mode: "any", includeDescendants: false }] },
      resolvedTags: [{ facetKey: "subject", text: "日落", tagId: 1, path: "" }],
      relation: "or",
    });
    render(<FilterChips />);
    expect(screen.getByText("条件（任一）")).toBeInTheDocument();
  });

  it("删除 chip 改 query（不重调 AI）", () => {
    resetStore({
      facetFilters: [{ facetKey: "color", tagIds: [2], mode: "any", includeDescendants: true }],
    }, [{ facetKey: "color", text: "红色", tagId: 2, path: "" }]);
    render(<FilterChips />);
    screen.getByRole("button", { name: "取消 色彩：红色" }).click();
    const st = useSuperSearchStore.getState();
    expect(st.query.facetFilters.length).toBe(0);
  });

  it("未知 tagId 退回「标签#id」", () => {
    resetStore({ facetFilters: [{ facetKey: "custom", tagIds: [99], mode: "any", includeDescendants: false }] });
    render(<FilterChips />);
    expect(screen.getByText("自定义 · 标签#99")).toBeInTheDocument();
  });
});