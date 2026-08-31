/** W7-2：ImportPage 页面级测试（W7-2 要求补页面级测试）。
 *  渲染 + 空库引导 + 选文件取消不崩溃 + 空清单报错提示。 */
import { render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ImportPage from "@/pages/ImportPage";
import { useSettingsStore } from "@/stores/settingsStore";
import { useLibraryStore } from "@/stores/libraryStore";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    listen: () => Promise.resolve(() => {}),
    onDragDropEvent: () => Promise.resolve(() => {}),
  }),
}));
vi.mock("@/api/import", () => ({
  inspectImport: vi.fn(),
  importFiles: vi.fn(),
  cancelImport: vi.fn(),
  onImportProgress: vi.fn().mockResolvedValue(() => {}),
  renderNamePreview: vi.fn(),
  openFileExternal: vi.fn(),
  markImportCancelling: vi.fn(),
}));
vi.mock("@/api/assets", () => ({
  listMetadataFacets: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/stores/taskStore", () => ({
  useTaskStore: { getState: () => ({ addTask: vi.fn() }) },
  markImportCancelling: vi.fn(),
}));

import { open as pickFiles } from "@tauri-apps/plugin-dialog";
import { inspectImport } from "@/api/import";

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState({
    loaded: true,
    settings: { libraryRoot: "d:/库" } as never,
  });
  useLibraryStore.setState({ items: [], total: 0, loading: false });
});

describe("ImportPage", () => {
  it("渲染空库引导（拖拽区 + 选择按钮）", () => {
    render(<ImportPage />);
    expect(screen.getByText("把图片 / 视频拖到这里")).toBeTruthy();
    expect(screen.getByText("选择文件…")).toBeTruthy();
    expect(screen.getByText("选择文件夹…")).toBeTruthy();
  });

  it("选文件取消（返回 null）不崩溃、不产生错误", async () => {
    vi.mocked(pickFiles).mockResolvedValue(null);
    render(<ImportPage />);
    fireEvent.click(screen.getByText("选择文件…"));
    expect(inspectImport).not.toHaveBeenCalled();
    expect(screen.queryByText(/未发现可入库/)).toBeNull();
  });

  it("选到空清单时给出明确错误提示", async () => {
    vi.mocked(pickFiles).mockResolvedValue(["d:/x.exe"]);
    vi.mocked(inspectImport).mockResolvedValue({
      items: [],
      images: 0,
      videos: 0,
      totalSize: 0,
    });
    render(<ImportPage />);
    fireEvent.click(screen.getByText("选择文件…"));
    await waitFor(() => {
      expect(screen.getByText("未发现可入库的图片/视频文件")).toBeTruthy();
    });
  });
});
