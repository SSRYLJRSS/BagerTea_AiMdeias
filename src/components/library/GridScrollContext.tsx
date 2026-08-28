/**
 * 网格滚动抑制（FB2-03 护栏）：滚动中及停止后 150ms 内不激活任何 hover 预览。
 * 用 context 而非 prop 逐层传 —— AssetCard 是 memo 组件，多一个高频变化的 prop 会毁掉 memo。
 * 关键：值是一个 () => boolean 函数，context 值本身不变（不触发 re-render），
 * 只在 hover 触发的那一刻读一次 isScrolling()。
 */
import { createContext } from "react";

export const GridScrollingContext = createContext<() => boolean>(() => false);