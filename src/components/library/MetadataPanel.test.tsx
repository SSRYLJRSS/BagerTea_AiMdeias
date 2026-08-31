import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import MetadataPanel from "@/components/library/MetadataPanel";
import { useMetadataStore } from "@/stores/metadataStore";
import { useLibraryStore } from "@/stores/libraryStore";

vi.mock("@/api/assets", () => ({
  listAssets: vi.fn().mockResolvedValue({ items: [], total: 0, hasMore: false }),
  listAssetIds: vi.fn().mockResolvedValue([]),
  listMetadataFacets: vi.fn().mockResolvedValue([]),
}));

beforeEach(() => {
  useMetadataStore.setState({
    loading: false,
    loaded: true,
    facets: [
      {
        key: "folder",
        displayName: "所在文件夹",
        description: "入库分库或素材原始目录",
        items: [{ value: "d:/library/旅行", label: "旅行", count: 3 }],
      },
      {
        key: "iso",
        displayName: "感光度",
        description: "ISO 拍摄参数",
        items: [
          { value: "100", label: "ISO 100", count: 2 },
          { value: "800", label: "ISO 800", count: 1 },
        ],
      },
      {
        key: "duration",
        displayName: "视频时长",
        description: "仅显示视频素材的时长区间",
        items: [{ value: "1_5m", label: "1–5 分钟", count: 2 }],
      },
    ],
  });
  useLibraryStore.setState((state) => ({
    ...state,
    filter: { ...state.filter, metadataFilters: [] },
  }));
});

describe("MetadataPanel", () => {
  it("支持单组折叠和全部展开收起", () => {
    render(<MetadataPanel />);
    expect(screen.getByText("旅行")).toBeVisible();
    expect(screen.getByText("1–5 分钟")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /所在文件夹/ }));
    expect(screen.queryByText("旅行")).not.toBeInTheDocument();
    expect(screen.getByText("1–5 分钟")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "全部收起" }));
    expect(screen.queryByText("1–5 分钟")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "全部展开" }));
    expect(screen.getByText("旅行")).toBeVisible();
    expect(screen.getByText("1–5 分钟")).toBeVisible();
  });

  it("数值分面多选合并为 in 数值条件", () => {
    render(<MetadataPanel />);
    fireEvent.click(screen.getByRole("button", { name: /ISO 100/ }));
    fireEvent.click(screen.getByRole("button", { name: /ISO 800/ }));
    expect(useLibraryStore.getState().filter.metadataFilters).toEqual([
      { key: "iso", op: "in", values: [100, 800] },
    ]);
  });

  it("清除 ISO 条件恢复全库", () => {
    render(<MetadataPanel />);
    fireEvent.click(screen.getByRole("button", { name: /ISO 100/ }));
    fireEvent.click(screen.getByRole("button", { name: /ISO 800/ }));
    expect(useLibraryStore.getState().filter.metadataFilters).toEqual([
      { key: "iso", op: "in", values: [100, 800] },
    ]);
    // 再次点击已选中的 ISO 值取消选择 → metadataFilters 清空，恢复全库
    fireEvent.click(screen.getByRole("button", { name: /ISO 100/ }));
    fireEvent.click(screen.getByRole("button", { name: /ISO 800/ }));
    expect(useLibraryStore.getState().filter.metadataFilters).toEqual([]);
  });
});

describe("W0-1/W0-2 分面点击与高亮", () => {
  it("metadataPanel_resolution_sends_number：分辨率分面点击产出像素乘积数值而非字符串 label", () => {
    useMetadataStore.setState({
      loading: false,
      loaded: true,
      facets: [
        {
          key: "resolution",
          displayName: "分辨率",
          description: "像素数",
          items: [{ value: "1920x1080", label: "1920x1080", count: 2 }],
        },
      ],
    });
    render(<MetadataPanel />);
    fireEvent.click(screen.getByRole("button", { name: /1920x1080/ }));
    const filters = useLibraryStore.getState().filter.metadataFilters;
    // 像素乘积 2073600 以数值进入 in 条件；字符串 "1920x1080" 会被后端 compile_number 拒绝
    expect(filters).toEqual([{ key: "resolution", op: "in", values: [2073600] }]);
  });

  it("metadataPanel_range_facet_stays_active：拍摄月份点选后高亮保持（key 被 bucketToFilter 改写）", () => {
    useMetadataStore.setState({
      loading: false,
      loaded: true,
      facets: [
        {
          key: "taken_month",
          displayName: "拍摄时间",
          description: "按月份",
          items: [
            { value: "2025-07", label: "2025-07", count: 2 },
            { value: "2025-08", label: "2025-08", count: 1 },
          ],
        },
      ],
    });
    render(<MetadataPanel />);
    const jul = screen.getByRole("button", { name: /2025-07/ });
    fireEvent.click(jul);
    // 点选产出的 filter key 是 taken_at（duration→duration_ms、taken_month→taken_at 同理）
    expect(useLibraryStore.getState().filter.metadataFilters).toEqual([
      { key: "taken_at", op: "between", min: "2025-07-01", max: "2025-07-31" },
    ]);
    // W0-2 回归：重渲染后高亮不丢（data-active 为 true）
    expect(jul.getAttribute("data-active")).toBe("true");
    expect(screen.getByRole("button", { name: /2025-08/ }).getAttribute("data-active")).toBe("false");
  });
});
