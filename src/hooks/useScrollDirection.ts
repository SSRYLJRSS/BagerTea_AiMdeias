/** 滚动方向状态（§12.2 FB-06 / FB2-06）：下滚收起、上滚恢复。
 *  - scroll listener passive；
 *  - rAF 合并事件（不在每个 scroll setState）；
 *  - 代码风格：不触发布局重排，只返回两态，由调用方决定动画（transform/opacity）。
 *  FB2-06（§7.3 方案 C）：非对称滞回阈值 + minScrollTop 顶部区恒展开 + suppressMs 手动设定抑制窗，
 *  消除「卸载 ↔ scrollHeight 钳制」的往复闪烁根因与边界抖动。
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type FilterChromeState = "expanded" | "collapsed";

export interface ScrollDirectionOptions {
  /** @deprecated 用 collapseThreshold / expandThreshold 替代；仍支持，作为两者缺省值 */
  threshold?: number;
  /** 收起阈值（px），缺省 24 —— 收起要滚得更多，避免误触 */
  collapseThreshold?: number;
  /** 展开阈值（px），缺省 12 —— 展开更灵敏（非对称滞回，消除边界抖动） */
  expandThreshold?: number;
  /** 低于此 scrollTop 恒为 expanded（px），缺省 48 —— 顶部区域收起毫无意义 */
  minScrollTop?: number;
  /** 程序化改变状态后忽略 scroll 事件的时长（ms），缺省 300 —— 手动设定不被滚动方向立刻覆盖 */
  suppressMs?: number;
}

/** 调用方把返回的 setNode 作为 ref 挂到滚动容器上。超过阈值后：
 *  下滚 -> collapsed，上滚 -> expanded。返回当前两态 + 强制展开/收起（§12.4 focus/抽屉）。 */
export function useScrollDirection(
  opts: ScrollDirectionOptions = {},
): [FilterChromeState, (el: HTMLElement | null) => void, (next: FilterChromeState) => void] {
  const { threshold = 15 } = opts;
  const collapseThreshold = useRef(opts.collapseThreshold ?? threshold);
  const expandThreshold = useRef(opts.expandThreshold ?? threshold);
  // minScrollTop 缺省 0：保留 `{ threshold }` 调用方的行为（旧测试依赖 scrollTop<48 也能收起）。
  // SuperSearchPage 显式传 48 启用「顶部区恒展开」。
  const minScrollTop = useRef(opts.minScrollTop ?? 0);
  const suppressMs = useRef(opts.suppressMs ?? 300);

  const [state, setState] = useState<FilterChromeState>("expanded");
  const nodeRef = useRef<HTMLElement | null>(null);
  const lastY = useRef(0);
  const lastDir = useRef<"down" | "up" | null>(null);
  const moved = useRef(0);
  const raf = useRef(0);
  const suppressUntil = useRef(0);

  const onScroll = useCallback(() => {
    const el = nodeRef.current;
    if (!el) return;
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const y = el.scrollTop;
      // minScrollTop：顶部区恒展开，但 lastY 仍更新，避免从顶部快速滚到中段产生巨大 delta
      if (y < minScrollTop.current) {
        lastY.current = y;
        lastDir.current = null;
        moved.current = 0;
        setState("expanded");
        return;
      }
      // suppress 窗：程序化设定后不响应滚动方向
      if (Date.now() < suppressUntil.current) {
        lastY.current = y;
        return;
      }
      const delta = y - lastY.current;
      lastY.current = y;
      if (Math.abs(delta) < 1) return; // 忽略微抖动
      const dir: "down" | "up" = delta < 0 ? "up" : "down";
      if (dir !== lastDir.current) {
        lastDir.current = dir;
        moved.current = 0; // 换向清零
      }
      moved.current += Math.abs(delta);
      const need = dir === "down" ? collapseThreshold.current : expandThreshold.current;
      if (moved.current >= need) {
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
    // 手动设定后短暂忽略滚动方向，避免被立即覆盖（FB2-06 suppressMs）
    suppressUntil.current = Date.now() + suppressMs.current;
    setState(next);
    moved.current = 0;
    lastDir.current = null;
  }, []);

  return [state, setNode, setExpanded];
}