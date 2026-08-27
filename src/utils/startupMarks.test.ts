/**
 * startupMarks 测试（指导书 §4.1）：打点记录与重置；测试环境默认静默（不打印）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getStartupMarks, markStartup, resetStartupMarks } from "@/utils/startupMarks";

beforeEach(() => {
  resetStartupMarks();
  vi.restoreAllMocks();
});

describe("startupMarks §4.1", () => {
  it("markStartup 记录节点（时间单调递增）", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    markStartup("react_first_render");
    markStartup("settings_ready");
    const marks = getStartupMarks();
    expect(marks.map((m) => m.mark)).toEqual(["react_first_render", "settings_ready"]);
    expect(marks[1].atMs).toBeGreaterThanOrEqual(marks[0].atMs);
  });

  it("getStartupMarks 返回副本，reset 清空", () => {
    markStartup("library_ready");
    const first = getStartupMarks();
    first.push({ mark: "first_thumbnail_ready", atMs: 1 }); // 修改副本不影响内部
    expect(getStartupMarks()).toHaveLength(1);
    resetStartupMarks();
    expect(getStartupMarks()).toHaveLength(0);
  });
});