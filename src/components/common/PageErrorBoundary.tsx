/**
 * 页面级 Error Boundary（指导书 A-1）：任何设置子组件/路由页的运行时异常都不得表现为无信息白屏。
 * - class Error Boundary，捕获 getDerivedStateFromError 与 componentDidCatch；
 * - 显示页面级错误状态（中文摘要），提供「重新加载」与「返回素材库」；
 * - 开发环境记录原始错误与 component stack；不吞错误（console.error）。
 * - 只包裹路由页，不把整个应用包成一个无法恢复的大边界。
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface PageErrorBoundaryProps {
  /** 重新加载：父层可提供重试动作（如重新加载设置） */
  onReset: () => void;
  /** 返回素材库：父层可提供的返回导航 */
  onBack: () => void;
  children: ReactNode;
}

interface PageErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  componentStack: string | null;
}

const isDev = import.meta.env?.DEV === true;

export default class PageErrorBoundary extends Component<PageErrorBoundaryProps, PageErrorBoundaryState> {
  state: PageErrorBoundaryState = { hasError: false, error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<PageErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ componentStack: info.componentStack ?? null });
    // 不吞错误：至少记录到控制台（开发环境含 stack）
    if (isDev) {
      console.error("[PageErrorBoundary] 页面渲染异常:", error, info.componentStack);
    } else {
      console.error("[PageErrorBoundary] 页面渲染异常:", error);
    }
  }

  private reset = () => {
    this.setState({ hasError: false, error: null, componentStack: null });
    // 父层可提供额外重试动作（如重新加载设置/数据）
    this.props.onReset();
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-base font-medium text-[var(--color-text)]">页面暂时无法显示</p>
        <p className="max-w-md text-sm text-[var(--color-text-secondary)]">
          页面数据或某个模块出现异常，可以重新加载，或返回素材库继续使用。
        </p>
        {isDev && this.state.error && (
          <pre className="max-h-40 max-w-full overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-left text-[11px] text-[var(--color-text-secondary)]">
            {String(this.state.error)}
            {"\n"}
            {this.state.error.stack ?? ""}
          </pre>
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={this.reset}
            className="rounded-[var(--radius-control)] bg-[var(--color-accent)] px-3.5 py-2 text-sm font-medium text-[var(--color-accent-text)] hover:bg-[var(--color-accent-hover)]"
          >
            重新加载
          </button>
          <button
            onClick={this.props.onBack}
            className="rounded-[var(--radius-control)] border border-[var(--color-border)] px-3.5 py-2 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface)]"
          >
            返回素材库
          </button>
        </div>
      </div>
    );
  }
}
