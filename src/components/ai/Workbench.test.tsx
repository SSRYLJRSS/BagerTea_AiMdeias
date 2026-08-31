/**
 * Workbench 一句话描述字段测试（FB5-05 §7.6）：
 *  - 单行 input、maxLength 20、字符计数按 JS 字符迭代（N/20）；
 *  - 确认按钮在「标签为空但描述非空」时仍可点击（§7.5）；
 *  - 已确认/已拒绝张只读展示（空描述显示「未生成描述」）。
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import Workbench from "@/components/ai/Workbench";
import type { AiSuggestion } from "@/types/ai";
import type { WorkbenchFacet } from "@/types/tag";

const mkSuggestion = (over: Partial<AiSuggestion> = {}): AiSuggestion => ({
  id: 1,
  batchId: 1,
  assetId: 1,
  assetPath: "/a.jpg",
  mimeType: "image/jpeg",
  suggestedTags: { subject: ["猫"] },
  status: "pending",
  confirmedTags: {},
  lastError: null,
  createdAt: 1,
  suggestedDescription: "",
  confirmedDescription: null,
  currentDescription: "",
  ...over,
});

const facets: WorkbenchFacet[] = [
  {
    key: "subject",
    displayName: "主体/对象",
    description: "",
    selectionMode: "multi",
    maxItems: 5,
    enabledForAi: true,
    hint: "",
  },
];

function renderWorkbench(over: Partial<AiSuggestion> = {}, description = "夜晚树下多人合影") {
  const onTagsChange = vi.fn();
  const onDescriptionChange = vi.fn();
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  const view = render(
    <Workbench
      suggestion={mkSuggestion(over)}
      facets={facets}
      tags={{ subject: ["猫"] }}
      onTagsChange={onTagsChange}
      description={description}
      onDescriptionChange={onDescriptionChange}
      index={0}
      total={1}
      onGoto={vi.fn()}
      onConfirm={onConfirm}
      onReject={vi.fn().mockResolvedValue(undefined)}
      onRestore={vi.fn().mockResolvedValue(undefined)}
    />,
  );
  return { ...view, onTagsChange, onDescriptionChange, onConfirm };
}

describe("Workbench 一句话描述（FB5-05 §7.6）", () => {
  it("描述为单行 input（maxLength 20），字符计数按 JS 字符迭代显示 N/20", () => {
    const { rerender } = renderWorkbench({}, "夜晚树下多人合影");
    const input = screen.getByRole("textbox", { name: "一句话描述" }) as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.maxLength).toBe(20);
    // 8 个字符 → 8/20
    expect(screen.getByText("8/20")).toBeInTheDocument();
    // 输入触发 onChange（受控组件由父级更新 prop）
    fireEvent.change(input, { target: { value: "海边" } });
    rerender(
      <Workbench
        suggestion={mkSuggestion()}
        facets={facets}
        tags={{ subject: ["猫"] }}
        onTagsChange={vi.fn()}
        description="海边"
        onDescriptionChange={vi.fn()}
        index={0}
        total={1}
        onGoto={vi.fn()}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
        onReject={vi.fn().mockResolvedValue(undefined)}
        onRestore={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByText("2/20")).toBeInTheDocument();
    // 表情符号（多字节）也按字符计
    rerender(
      <Workbench
        suggestion={mkSuggestion()}
        facets={facets}
        tags={{ subject: ["猫"] }}
        onTagsChange={vi.fn()}
        description="🌅海边"
        onDescriptionChange={vi.fn()}
        index={0}
        total={1}
        onGoto={vi.fn()}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
        onReject={vi.fn().mockResolvedValue(undefined)}
        onRestore={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByText("3/20")).toBeInTheDocument();
  });

  it("标签为空但描述非空：确认按钮可点击（§7.5）", () => {
    const { onConfirm } = renderWorkbench({}, "纯红底色");
    const btn = screen.getByRole("button", { name: "确认写入" });
    expect(btn.hasAttribute("disabled")).toBe(false);
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("已确认张：描述只读展示（无 input）；空描述显示「未生成描述」", () => {
    renderWorkbench({ status: "confirmed", confirmedTags: { subject: ["猫"] } }, "");
    expect(screen.queryByRole("textbox", { name: "一句话描述" })).not.toBeInTheDocument();
    expect(screen.getByText("未生成描述")).toBeInTheDocument();
    expect(screen.getByText("✓ 已写入")).toBeInTheDocument();
  });
});
