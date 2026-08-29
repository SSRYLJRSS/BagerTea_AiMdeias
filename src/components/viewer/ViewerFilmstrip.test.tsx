/** FB3-02（§4.3）：胶片条布局语义 —— 双行网格、只横向滚动、点击定位 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ViewerFilmstrip from "@/components/viewer/ViewerFilmstrip";
import type { Asset } from "@/types/asset";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
}));

function mkAsset(id: number): Asset {
  return {
    id,
    filePath: `d:/lib/a${id}.jpg`,
    fileName: `a${id}.jpg`,
    fileExt: "jpg",
    fileSize: 100,
    mimeType: "image/jpeg",
    width: 800,
    height: 600,
    durationMs: null,
    videoCodec: null,
    audioCodec: null,
    takenAt: null,
    createdAt: 1,
    modifiedAt: 1,
    hash: null,
    placeholderPath: `thumb${id}.jpg`,
    hdThumbnailPath: null,
    camera: null,
    lens: null,
    iso: null,
    aperture: null,
    shutter: null,
    focal: null,
    tags: [],
  };
}

function getGrid(container: HTMLElement): HTMLElement {
  const strip = container.querySelector("[data-filmstrip]") as HTMLElement;
  // 缩略图区是 filmstrip 内第二个子节点（prev 按钮 → grid → next 按钮）
  return strip.children[1] as HTMLElement;
}

describe("ViewerFilmstrip（FB3-02 双排胶片条）", () => {
  it("缩略图区是两行网格（grid-template-rows repeat(2, minmax(0,1fr)) + 纵向列流）", () => {
    const { container } = render(
      <ViewerFilmstrip items={[mkAsset(1), mkAsset(2), mkAsset(3), mkAsset(4), mkAsset(5)]} currentId={1} onJump={vi.fn()} onPrev={vi.fn()} onNext={vi.fn()} />,
    );
    const grid = getGrid(container);
    expect(grid.style.gridTemplateRows).toBe("repeat(2, minmax(0, 1fr))");
    expect(grid.style.gridAutoFlow).toBe("column");
    expect(grid.style.gridAutoColumns).toBe("56px");
  });

  it("只横向滚动：overflow-x auto、overflow-y hidden（无纵向滚动）", () => {
    const { container } = render(
      <ViewerFilmstrip items={Array.from({ length: 20 }, (_, i) => mkAsset(i + 1))} currentId={1} onJump={vi.fn()} onPrev={vi.fn()} onNext={vi.fn()} />,
    );
    const grid = getGrid(container);
    expect(grid.className).toContain("overflow-x-auto");
    expect(grid.className).toContain("overflow-y-hidden");
  });

  it("1 / 2 / 3 个素材都保持两行结构（少量素材不塌成单行）", () => {
    for (const n of [1, 2, 3]) {
      const { container } = render(
        <ViewerFilmstrip items={Array.from({ length: n }, (_, i) => mkAsset(i + 1))} currentId={1} onJump={vi.fn()} onPrev={vi.fn()} onNext={vi.fn()} />,
      );
      const grid = getGrid(container);
      expect(grid.style.gridTemplateRows).toBe("repeat(2, minmax(0, 1fr))");
      expect(grid.querySelectorAll("button")).toHaveLength(n);
    }
  });

  it("点击缩略图调用 onJump(index)；左右按钮调用 onPrev/onNext", () => {
    const onJump = vi.fn();
    const onPrev = vi.fn();
    const onNext = vi.fn();
    render(
      <ViewerFilmstrip items={[mkAsset(1), mkAsset(2), mkAsset(3)]} currentId={1} onJump={onJump} onPrev={onPrev} onNext={onNext} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "第 3 张：a3.jpg" }));
    expect(onJump).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getByRole("button", { name: "上一张" }));
    expect(onPrev).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "下一张" }));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("当前素材高亮（accent 边框）；缩略图区 min-w-0 防按钮挤压", () => {
    const { container } = render(
      <ViewerFilmstrip items={[mkAsset(1), mkAsset(2)]} currentId={2} onJump={vi.fn()} onPrev={vi.fn()} onNext={vi.fn()} />,
    );
    const grid = getGrid(container);
    expect(grid.className).toContain("min-w-0");
    // aria-label 含当前文件名（第 2 张）的按钮带 accent 类
    const current = screen.getByRole("button", { name: "第 2 张：a2.jpg" });
    expect(current.className).toContain("border-[var(--color-accent)]");
  });
});
