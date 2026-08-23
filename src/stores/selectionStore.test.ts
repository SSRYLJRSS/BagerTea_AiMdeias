/**
 * selectionStore 测试：网格多选语义（PRD v2.8 / M7 BAT-001~006, LIB-018）
 * 纯 Zustand 状态，无 DOM 依赖。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useSelectionStore } from "@/stores/selectionStore";

beforeEach(() => {
  useSelectionStore.setState({ selected: new Set(), anchorIndex: null });
});

describe("selectionStore 多选语义", () => {
  it("单击选中：非加性 toggle 替换独占选中", () => {
    useSelectionStore.getState().toggle(1, 0, false);
    useSelectionStore.getState().toggle(2, 1, false);
    const s = useSelectionStore.getState();
    expect(s.selected).toEqual(new Set([2]));
    expect(s.anchorIndex).toBe(1); // 锚点跟随最后一次单击
  });

  it("Ctrl 加选：追加选中", () => {
    const s = useSelectionStore.getState();
    s.toggle(1, 0, true);
    s.toggle(2, 1, true);
    expect(useSelectionStore.getState().selected).toEqual(new Set([1, 2]));
  });

  it("再击同张取消选中（独占选中语义）", () => {
    useSelectionStore.getState().toggle(1, 0, true);
    useSelectionStore.getState().toggle(2, 1, true);
    useSelectionStore.getState().toggle(1, 0, true); // 再击第 1 张
    expect(useSelectionStore.getState().selected).toEqual(new Set([2]));
  });

  it("Shift 范围选：从锚点到目标（正向，追加语义）", () => {
    const s = useSelectionStore.getState();
    s.toggle(10, 0, false); // 单击 index 0（id=10）为锚点
    s.rangeTo(4, [10, 11, 12, 13, 14]);
    expect(useSelectionStore.getState().selected).toEqual(
      new Set([10, 11, 12, 13, 14]),
    );
  });

  it("Shift 反向范围选（锚点 3 → 目标 1）", () => {
    const s = useSelectionStore.getState();
    s.toggle(13, 3, false); // 单击 index 3（id=13）为锚点
    s.rangeTo(1, [10, 11, 12, 13]);
    expect(useSelectionStore.getState().selected).toEqual(
      new Set([11, 12, 13]),
    );
  });

  it("Ctrl+A（setAll）：全选并更新锚点到末位", () => {
    useSelectionStore.getState().setAll([5, 6, 7]);
    const s = useSelectionStore.getState();
    expect(s.selected).toEqual(new Set([5, 6, 7]));
    expect(s.anchorIndex).toBe(2);
  });

  it("Ctrl+I（invert）：未选中的进结果，已选中被排除", () => {
    const s = useSelectionStore.getState();
    s.toggle(5, 0, false);
    s.toggle(6, 1, true);
    s.invert([5, 6, 7, 8]);
    expect(useSelectionStore.getState().selected).toEqual(new Set([7, 8]));
  });

  it("空白处点击/Esc（clear）：清空并复位锚点", () => {
    useSelectionStore.getState().toggle(1, 0, true);
    useSelectionStore.getState().clear();
    const s = useSelectionStore.getState();
    expect(s.selected.size).toBe(0);
    expect(s.anchorIndex).toBeNull();
  });

  it("count / isSelected 一致", () => {
    const s = useSelectionStore.getState();
    expect(s.count()).toBe(0);
    expect(s.isSelected(42)).toBe(false);
    s.toggle(42, 0, true);
    expect(useSelectionStore.getState().count()).toBe(1);
    expect(useSelectionStore.getState().isSelected(42)).toBe(true);
  });
});