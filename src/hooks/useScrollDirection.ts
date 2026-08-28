/** 滚动方向状态（§12.2 FB-06）：下滚收起、上滚恢复。
 *  - scroll listener passive；
 *  - rAF 合并事件（不在每个 scroll setState）；
 *  - 累计同向位移超过阈值（15px）才切换；
 *  - 只返回两态，由调用方决定动画（transform/opacity），本 hook 不触发布局重排。
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type FilterChromeState = "expanded" | "collapsed";

export interface ScrollDirectionOptions {
  /** 切换阈值（px），缺省 15 */
  threshold?: number;
}

/** 调用方把返回的 setNode 作为 ref 挂到滚动容器上。超过阈值后：
 *  下滚 -> collapsed，上滚 -> expanded。返回当前两态 + 强制展开/收起（§12.4 focus/抽屉）。 */
export function useScrollDirection(
  { threshold = 15 }: ScrollDirectionOptions = {},
): [FilterChromeState, (el: HTMLElement | null) => void, (next: FilterChromeState) => void] {
  const [state, setState] = useState<FilterChromeState>("expanded");
  const nodeRef = useRef<HTMLElement | null>(null);
  const lastY = useRef(0);
  const lastDir = useRef<"down" | "up" | null>(null);
  const moved = useRef(0);
  const raf = useRef(0);
  const thresholdRef = useRef(threshold);

  const onScroll = useCallback(() => {
    const el = nodeRef.current;
    if (!el) return;
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const y = el.scrollTop;
      const delta = y - lastY.current;
      lastY.current = y;
      if (Math.abs(delta) < 1) return; // 忽略微抖动
      const dir: "down" | "up" = delta < 0 ? "up" : "down";
      if (dir !== lastDir.current) {
        lastDir.current = dir;
        moved.current = 0; // 换向清零
      }
      moved.current += Math.abs(delta);
      if (moved.current >= thresholdRef.current) {
        moved.current = 0;
        setState(dir === "down" ? "collapsed" : "expanded");
      }
    });
  }, []);

  const setNode = useCallback((el: HTMLElement | null) => {
    if (raf.current) cancelAnimationFrame(raf.current);
    nodeRef.current?.removeEventListener("scroll", onScroll);
    nodeRef.current = el;
    lastY.current = 0;
    lastDir.current = null;
    moved.current = 0;
    setState("expanded");
    if (el) {
      el.addEventListener("scroll", onScroll, { passive: true });
      lastY.current = el.scrollTop;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, []);

  const setExpanded = useCallback((next: FilterChromeState) => {
    setState(next);
    if (next === "expanded") {
      moved.current = 0;
      lastDir.current = null;
    }
  }, []);

  return [state, setNode, setExpanded];
}