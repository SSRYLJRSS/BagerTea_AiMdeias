import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import PendingList from "@/components/import/PendingList";
import type { ImportPlanItem } from "@/api/import";

const items: ImportPlanItem[] = [
  { path: "d:/p/a.jpg", kind: "image", size: 1024 * 512 },
  { path: "d:/p/b.mp4", kind: "video", size: 1024 * 1024 * 5 },
];

describe("PendingList 固定动作头部", () => {
  it("清单非空时提供添加文件/添加文件夹/清空入口与数量/大小", () => {
    render(<PendingList items={items} running={false} onRemove={() => {}} />);
    expect(screen.getByRole("button", { name: "添加文件" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加文件夹" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "清空清单" })).toBeInTheDocument();
    expect(screen.getByText(/2 项/)).toBeInTheDocument();
  });

  it("点击添加文件/文件夹/清空调用对应事件（不直接 invoke）", () => {
    const onAddFiles = vi.fn();
    const onAddFolder = vi.fn();
    const onClear = vi.fn();
    render(
      <PendingList
        items={items}
        running={false}
        onRemove={() => {}}
        onAddFiles={onAddFiles}
        onAddFolder={onAddFolder}
        onClear={onClear}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
    fireEvent.click(screen.getByRole("button", { name: "添加文件夹" }));
    fireEvent.click(screen.getByRole("button", { name: "清空清单" }));
    expect(onAddFiles).toHaveBeenCalledTimes(1);
    expect(onAddFolder).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("入库运行中禁用添加/清空", () => {
    const onAddFiles = vi.fn();
    const onClear = vi.fn();
    render(
      <PendingList items={items} running onRemove={() => {}} onAddFiles={onAddFiles} onClear={onClear} />,
    );
    expect(screen.getByRole("button", { name: "添加文件" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "添加文件夹" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "清空清单" })).toBeDisabled();
  });
});
