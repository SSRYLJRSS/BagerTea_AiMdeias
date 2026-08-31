/**
 * FB2-08（§14.14）：ColorStrip 组件测试。
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ColorStrip from "@/components/library/ColorStrip";
import type { PaletteSegment } from "@/components/library/ColorStrip";

const seg = (hex: string, ratio: number, hue: number, sat = 70, lum = 50): PaletteSegment => ({
  hex,
  ratio,
  hue,
  sat,
  lum,
});

describe("ColorStrip", () => {
  it("空色板不渲染", () => {
    const { container } = render(<ColorStrip palette={[]} />);
    expect(container.firstChild).toBeNull();
  });

  // FB6 需求三：rounded 只负责底边圆角（顶边与媒体框直角贴合，无缝拼接）
  it("rounded=true 时只有底边圆角，顶部无圆角无空白", () => {
    render(<ColorStrip palette={[seg("#000", 1, 0)]} rounded />);
    const el = screen.getByRole("img") as HTMLElement;
    expect(el.style.borderRadius).toBe("0 0 4px 4px");
    // 不产生上边距/外边框/额外 padding
    expect(el.style.margin).toBe("");
    expect(el.style.border).toBe("");
    expect(el.style.padding).toBe("");
  });

  it("rounded=false 时无圆角（Viewer 场景）", () => {
    render(<ColorStrip palette={[seg("#000", 1, 0)]} />);
    expect((screen.getByRole("img") as HTMLElement).style.borderRadius).toBe("");
  });

  it("role=img + aria-label 含中文色名与占比", () => {
    render(<ColorStrip palette={[seg("#ff0000", 0.31, 0, 80, 50), seg("#fff", 0.22, 0, 3, 95)]} />);
    const el = screen.getByRole("img");
    expect(el.getAttribute("aria-label")).toContain("主色");
    expect(el.getAttribute("aria-label")).toContain("红");
    expect(el.getAttribute("aria-label")).toContain("31%");
    expect(el.getAttribute("aria-label")).toContain("白");
  });

  it("主色段可点击，非主色段不可点击", () => {
    const onSearch = vi.fn();
    render(
      <ColorStrip
        palette={[seg("#ff0000", 0.5, 0), seg("#00ff00", 0.3, 120), seg("#0000ff", 0.2, 240)]}
        onSearchDominant={onSearch}
      />,
    );
    const children = screen.getAllByTitle(/·/);
    expect(children[0].style.cursor).toBe("pointer");
    children[0].click();
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(children[1].style.cursor).toBe("default");
    expect(children[2].style.cursor).toBe("default");
  });

  it("三档高度类正确设置像素高度", () => {
    const { rerender } = render(<ColorStrip palette={[seg("#000", 1, 0)]} height="thin" />);
    expect((screen.getByRole("img") as HTMLElement).style.height).toBe("6px");
    rerender(<ColorStrip palette={[seg("#000", 1, 0)]} height="normal" />);
    expect((screen.getByRole("img") as HTMLElement).style.height).toBe("10px");
    rerender(<ColorStrip palette={[seg("#000", 1, 0)]} height="thick" />);
    expect((screen.getByRole("img") as HTMLElement).style.height).toBe("16px");
  });

  // FB2-08（FX-07）：count 接线后新增的用例
  it("count=4 时 8 段只渲染前 4 段", () => {
    const palette = [
      seg("#111111", 0.2, 0), seg("#222222", 0.2, 30), seg("#333333", 0.15, 60), seg("#444444", 0.1, 120),
      seg("#555555", 0.1, 200), seg("#666666", 0.1, 240), seg("#777777", 0.08, 280), seg("#888888", 0.07, 320),
    ];
    render(<ColorStrip palette={palette} count={4} />);
    const children = screen.getAllByTitle(/·/);
    expect(children).toHaveLength(4);
    expect(children[0].getAttribute("title")).toContain("#111111");
    expect(children[3].getAttribute("title")).toContain("#444444");
  });

  it("mode=equal 时各段宽度相等", () => {
    render(
      <ColorStrip
        palette={[seg("#ff0000", 0.7, 0), seg("#00ff00", 0.2, 120), seg("#0000ff", 0.1, 240)]}
        mode="equal"
      />,
    );
    const children = screen.getAllByTitle(/·/);
    for (const c of children) {
      expect(c.style.width).toBe(`${100 / 3}%`);
    }
  });

  it("有回调时主色段是键盘可达的 button；无回调时是 div", () => {
    const palette = [seg("#ff0000", 0.5, 0), seg("#00ff00", 0.5, 120)];
    const onSearch = vi.fn();
    const { rerender } = render(
      <ColorStrip palette={palette} onSearchDominant={onSearch} />,
    );
    const btn = screen.getByRole("button", { name: /搜索.*系素材/ });
    expect(btn.tagName).toBe("BUTTON");
    fireEvent.click(btn);
    expect(onSearch).toHaveBeenCalledTimes(1);
    // 无回调：主色段退化为纯展示 div，不可聚焦
    rerender(<ColorStrip palette={palette} />);
    expect(screen.queryByRole("button", { name: /搜索/ })).toBeNull();
  });
});