/** W7-2：AiSearchBar 三态展示（W6-5）—— full 蓝字 / partial 黄字警告 / keyword 黄字兜底 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AiSearchBar from "@/components/supersearch/AiSearchBar";
import { useSuperSearchStore } from "@/stores/superSearchStore";

const renderBar = () =>
  render(<AiSearchBar onSubmit={vi.fn()} />);

describe("AiSearchBar 三态", () => {
  beforeEach(() => {
    useSuperSearchStore.setState({
      aiInput: "海边",
      aiExplanation: null,
      warnings: [],
      parseStatus: null,
      aiError: null,
    });
  });

  it("full：显示解释，无警告", () => {
    useSuperSearchStore.setState({
      aiExplanation: "筛选「海边」",
      warnings: [],
      parseStatus: "full",
    });
    renderBar();
    expect(screen.getByText(/AI 已转换为下方条件/)).toBeTruthy();
    expect(screen.queryByText(/部分条件|按关键词搜索/)).toBeNull();
  });

  it("partial：黄字警告 + 部分理解文案", () => {
    useSuperSearchStore.setState({
      aiExplanation: "筛选「海边」",
      warnings: ["已忽略无效的元数据条件"],
      parseStatus: "partial",
    });
    renderBar();
    expect(screen.getByText(/部分条件未能准确理解/)).toBeTruthy();
    expect(screen.getByText("已忽略无效的元数据条件")).toBeTruthy();
  });

  it("keyword：按关键词搜索文案，不显示红字", () => {
    useSuperSearchStore.setState({
      aiExplanation: "按关键词搜索",
      warnings: ["未能理解搜索条件，已按关键词搜索。"],
      parseStatus: "keyword",
    });
    renderBar();
    expect(screen.getByText(/已按关键词搜索：海边/)).toBeTruthy();
  });

  it("aiError：配置错误仍显示红字 + 按原文搜索按钮", () => {
    useSuperSearchStore.setState({ aiError: "云端请求失败: 401" });
    renderBar();
    expect(screen.getByText(/AI 解析失败/)).toBeTruthy();
    expect(screen.getByText("按原文搜索")).toBeTruthy();
  });
});
