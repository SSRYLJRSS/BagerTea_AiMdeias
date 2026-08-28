/**
 * FB2-08（§14.14）：ColorStrip 组件测试。
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
});