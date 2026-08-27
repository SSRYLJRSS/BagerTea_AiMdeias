/**
 * 启动埋点（指导书 阶段 1 §4.1）：轻量、可关闭的开发诊断时间戳，不记录敏感信息。
 *
 * - `markStartup` 在关键节点打点（react 首帧、设置 ready、素材列表 ready、首缩略图 ready 等）；
 * - 生产构建默认不打印详细日志（import.meta.env.PROD 且未显式开启）；
 * - 开发构建或显式环境变量 `VITE_STARTUP_MARKS=1` 时打印 `[startup] <ms> <mark>`；
 * - 打点同时记录到模块级数组，测试与阶段报告可读取（不依赖控制台）。
 */
export type StartupMark =
  | "html_dom_content_loaded"
  | "react_first_render"
  | "settings_ready"
  | "library_ready"
  | "first_thumbnail_ready";

/** 全部打点（{ mark, atMs }，atMs 相对首次调用时间戳）。 */
export interface StartupMarkEntry {
  mark: StartupMark;
  /** 距起点毫秒数（performance.now() 可用时用它，否则 Date.now() 差值） */
  atMs: number;
}

const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
const entries: StartupMarkEntry[] = [];

/** 是否打印详细日志：开发构建或显式开启；测试环境（mode=test）默认静默。 */
function shouldLog(): boolean {
  if (typeof import.meta.env === "undefined") return false;
  if (import.meta.env.VITE_STARTUP_MARKS === "1" || import.meta.env.VITE_STARTUP_MARKS === "true") return true;
  if (import.meta.env.MODE === "test" || import.meta.env.PROD) return false;
  return import.meta.env.DEV;
}

/** 记录一个启动节点。 */
export function markStartup(mark: StartupMark): void {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  const atMs = Math.round((now - t0) * 10) / 10;
  entries.push({ mark, atMs });
  if (!shouldLog()) return;
  // eslint-disable-next-line no-console
  console.info(`[startup] ${atMs.toFixed(1)}ms ${mark}`);
}

/** 读取已打点序列（测试/报告用；返回副本，不可变更内部状态）。 */
export function getStartupMarks(): StartupMarkEntry[] {
  return [...entries];
}

/** 清空打点（测试隔离用）。 */
export function resetStartupMarks(): void {
  entries.length = 0;
}