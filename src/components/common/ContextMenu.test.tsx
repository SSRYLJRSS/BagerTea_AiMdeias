import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ContextMenu from "@/components/common/ContextMenu";

describe("ContextMenu", () => {
  it("鼠标从打标项横向移入子菜单时保持打开并可点击 AI", () => {
    const onAi = vi.fn();
    render(
      <ContextMenu
        x={100}
        y={100}
        entries={[{ label: "打标", children: [{ label: "AI", onClick: onAi }, { label: "手动", onClick: vi.fn() }] }]}
        onClose={vi.fn()}
      />,
    );

    fireEvent.mouseEnter(screen.getByText("打标").parentElement!);
    const ai = screen.getByRole("button", { name: "AI" });
    expect(ai.parentElement).toHaveStyle({ marginLeft: "-1px" });
    fireEvent.mouseEnter(ai);
    expect(ai).toBeInTheDocument();
    fireEvent.click(ai);
    expect(onAi).toHaveBeenCalledOnce();
  });
});
