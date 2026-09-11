/** 滚动方向状态（§12.2 FB-06 / FB2-06 + FB3-06 §8.1）：
 *  - 下滚超过阈值：收起；
 *  - 上滑（无论累计多少）：保持收起 —— 只有回到顶部区（scrollTop <= minScrollTop）才自动展开；
 *  - 用户点击「展开详细条件」立即展开（setExpanded + suppress 窗，不被同段滚动马上收回）；
 *  - scroll listener passive；rAF 合并事件。
 *  FB3-06 行为变更（旧→新）：旧语义「上滑累计达 expandThreshold 即展开」改为「仅顶部区自动展开」；
 *  minScrollTop 语义从「顶部区恒展开的兜底」升级为「唯一的自动展开条件」，expandThreshold 保留给
 *  非顶部场景的手动展开抑制计算（不再触发自动展开）。
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
  // FB3-06：expandThreshold 不再触发自动展开（只有回顶部才展开），保留解析以兼容旧调用方
  // 的参数形状（传了也不报错），语义见文件头注释。
  const expandThreshold = useRef(opts.expandThreshold ?? threshold);
  void expandThreshold;
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
  /**
   * 自动收起防闪烁护栏（FB2-06 闪烁回路补丁）：
   * 收起会让头部变矮、滚动视口变高；结果不多时浏览器把 scrollTop 向下钳制并派发一个
   * scroll 事件，常恰好落回顶部区（y<=minScrollTop），旧逻辑立刻又自动展开，与用户滚动
   * 互相打架 → 条件区/图片一直闪烁。判据必须是「结构性」的：仅当首个后续事件发生时
   * 视口确实因本次收起而变高（clientHeight 增大）、且位置被钳回顶部区，才拦截一次；
   * 用户主动拖回顶部（视口尺寸不变）不拦，避免「回不了顶、展不开」。
   */
  const collapseGuard = useRef<{ client: number; y: number } | null>(null);

  const onScroll = useCallback(() => {
    const el = nodeRef.current;
    if (!el) return;
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const y = el.scrollTop;
      // 自动收起后的首个事件：判断是否为「视口变高 → scrollTop 被钳回顶部区」的钳位事件
      let clampedByCollapse = false;
      if (collapseGuard.current) {
        const g = collapseGuard.current;
        collapseGuard.current = null;
        const viewportGrew = el.clientHeight > g.client + 1;
        clampedByCollapse = viewportGrew && y < g.y && y <= minScrollTop.current;
      }
      // FB3-06：顶部区是唯一自动展开条件（下滚收起后，上滑必须回到顶部才展开）。
      // 钳位事件不算数，否则会「收起→钳回顶部→展开」闪烁。
      if (y <= minScrollTop.current) {
        if (clampedByCollapse) {
          lastY.current = y;
          return;
        }
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
      // FB3-06：仅下滚收起；非顶部的上滑保持收起（用户点了「展开」才是展开来源）
      if (dir === "down" && moved.current >= collapseThreshold.current) {
        moved.current = 0;
        // 记录收起瞬间的视口高度，供下一事件判断是否为视口变高触发的钳位（见 collapseGuard）
        collapseGuard.current = { client: el.clientHeight, y };
        setState("collapsed");
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
    collapseGuard.current = null;
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
    // 手动设定优先：清掉自动收起遗留的钳位护栏
    collapseGuard.current = null;
    setState(next);
    moved.current = 0;
    lastDir.current = null;
  }, []);

  return [state, setNode, setExpanded];
}