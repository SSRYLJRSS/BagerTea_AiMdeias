import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useDoubleAction } from "@/hooks/useDoubleAction";

describe("useDoubleAction", () => {
  beforeEach(() => vi.useFakeTimers());

  it("单击在延迟后触发 onSingle", () => {
    const onSingle = vi.fn();
    const onDouble = vi.fn();
    const { result } = renderHook(() => useDoubleAction(onSingle, onDouble));
    result.current.onClick();
    expect(onSingle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(230);
    expect(onSingle).toHaveBeenCalledTimes(1);
    expect(onDouble).not.toHaveBeenCalled();
  });

  it("双击取消单击并触发 onDouble（不闪切）", () => {
    const onSingle = vi.fn();
    const onDouble = vi.fn();
    const { result } = renderHook(() => useDoubleAction(onSingle, onDouble));
    result.current.onClick();
    result.current.onDoubleClick();
    vi.advanceTimersByTime(230);
    expect(onSingle).not.toHaveBeenCalled();
    expect(onDouble).toHaveBeenCalledTimes(1);
  });

  it("卸载时清理计时器（不触发 onSingle）", () => {
    const onSingle = vi.fn();
    const onDouble = vi.fn();
    const { result, unmount } = renderHook(() => useDoubleAction(onSingle, onDouble));
    result.current.onClick();
    unmount();
    vi.advanceTimersByTime(300);
    expect(onSingle).not.toHaveBeenCalled();
  });
});
