/** W7-2：metadataStore —— 唯一无测试的 store（W7-1 要求补齐） */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listMetadataFacets } from "@/api/assets";
import { useMetadataStore } from "@/stores/metadataStore";

vi.mock("@/api/assets", () => ({
  listMetadataFacets: vi.fn(),
}));

describe("metadataStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMetadataStore.setState({ facets: [], loading: false, loaded: false });
  });

  it("refresh 拉取分面并置 loaded", async () => {
    vi.mocked(listMetadataFacets).mockResolvedValue([
      { key: "taken_at", displayName: "拍摄时间", description: "", items: [] },
    ]);
    await useMetadataStore.getState().refresh();
    const st = useMetadataStore.getState();
    expect(st.loading).toBe(false);
    expect(st.loaded).toBe(true);
    expect(st.facets).toHaveLength(1);
    expect(listMetadataFacets).toHaveBeenCalledTimes(1);
  });

  it("refresh 失败不抛错，loaded 仍置位（空分面）", async () => {
    vi.mocked(listMetadataFacets).mockRejectedValue(new Error("boom"));
    await expect(useMetadataStore.getState().refresh()).resolves.toBeUndefined();
    const st = useMetadataStore.getState();
    expect(st.loaded).toBe(true);
    expect(st.facets).toHaveLength(0);
  });
});
