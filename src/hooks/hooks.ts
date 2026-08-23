/** T04 通用 hooks：防抖 / Tauri 事件订阅 / Esc 键 / 元素尺寸 */
import { useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";

/** 值防抖（搜索关键词等） */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

/** 订阅 Tauri 事件，自动取消订阅（防内存泄漏） */
export function useTauriEvent(subscribe: () => Promise<UnlistenFn>, deps: unknown[] = []) {
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    subscribe()
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      // P2-02：订阅失败（如 Tauri API 暂不可用/测试环境）不能被 Promise.all 之外的空
      // then 链吞成 unhandled rejection；cleanup 由 cancelled 标志兜底，失败不阻断渲染
      .catch((e) => {
        console.error("Tauri 事件订阅失败", e);
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** Esc 键回调（取消选中 / 关弹窗） */
export function useEscape(handler: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handler();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handler, active]);
}

/** 元素尺寸观测（虚拟网格算列数用） */
export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, ...size };
}
