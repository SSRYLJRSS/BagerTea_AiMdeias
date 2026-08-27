import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useHoverIntent } from "@/hooks/useHoverIntent";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useHoverIntent", () => {
  it("进入后延迟 300ms 才激活（快速扫过不触发）", () => {
    const { result } = renderHook(() => useHoverIntent({ enter: 300, leave: 350 }));
    result.current.triggerProps.onMouseEnter();
    expect(result.current.active).toBe(false);
    result.current.triggerProps.onMouseLeave(); // 快速离开 → 取消激活
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.active).toBe(false);
  });

  it("进入停留 300ms 激活，离开 350ms 后关闭", () => {
    const { result } = renderHook(() => useHoverIntent({ enter: 300, leave: 350 }));
    result.current.triggerProps.onMouseEnter();
    act(() => vi.advanceTimersByTime(300));
    expect(result.current.active).toBe(true);
    result.current.triggerProps.onMouseLeave();
    expect(result.current.active).toBe(true); // 仍在停留期
    act(() => vi.advanceTimersByTime(350));
    expect(result.current.active).toBe(false);
  });

  it("键盘 focus 激活预览，blur 关闭", () => {
    const { result } = renderHook(() => useHoverIntent({ enter: 300, leave: 350 }));
    result.current.triggerProps.onFocus();
    act(() => vi.advanceTimersByTime(300));
    expect(result.current.active).toBe(true);
    result.current.triggerProps.onBlur();
    act(() => vi.advanceTimersByTime(350));
    expect(result.current.active).toBe(false);
  });

  it("cancel 立即取消待激活/待关闭计时", () => {
    const { result } = renderHook(() => useHoverIntent({ enter: 300, leave: 350 }));
    result.current.triggerProps.onMouseEnter();
    result.current.cancel(); // 切换卡片
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.active).toBe(false);
    expect(result.current.inside).toBe(false);
  });

  it("disabled 时不激活", () => {
    const { result } = renderHook(() => useHoverIntent({ enter: 300, leave: 350, disabled: true }));
    result.current.triggerProps.onMouseEnter();
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.active).toBe(false);
  });
});
