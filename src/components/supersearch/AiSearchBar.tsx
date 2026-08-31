/** 超级搜索唯一主输入框：普通关键词与自然语言条件统一从这里进入。
 *  FB5-05（§9.7）：AI 解析失败只显示 aiError，不自动把整句执行为全文搜索；
 *  提供明确命令「按原文搜索」，只有用户点击后才生成全文条件。
 *  FB6 需求五：搜索框上方显示「超级搜索」页面标识（唯一可见标题，字号克制，非营销式 hero）。
 *  W6-5（§W6-5）：warning 一律黄字列表；解释按 parseStatus 区分三态 ——
 *  full = 蓝字解释；partial = 黄字「部分条件无法理解」；keyword = 黄字「按关键词搜索」。 */
import { FormEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { useSuperSearchStore } from "@/stores/superSearchStore";

const EXAMPLES = ["2025 年拍的横图海边素材，大于 5MB", "Sony 拍的视频，时长 10 秒以上", "清新的竖版人像，不要夜景"];

interface AiSearchBarProps { onSubmit: (text: string) => void; }

export default function AiSearchBar({ onSubmit }: AiSearchBarProps) {
  const { aiInput, setAiInput, aiLoading, aiError, aiExplanation, warnings, parseStatus, setQuery } = useSuperSearchStore(
    useShallow((s) => ({
      aiInput: s.aiInput,
      setAiInput: s.setAiInput,
      aiLoading: s.aiLoading,
      aiError: s.aiError,
      aiExplanation: s.aiExplanation,
      warnings: s.warnings,
      parseStatus: s.parseStatus,
      setQuery: s.setQuery,
    })),
  );
  const submit = (event?: FormEvent) => { event?.preventDefault(); const text = aiInput.trim(); if (text) onSubmit(text); };
  // §9.7：只有用户点击「按原文搜索」才生成全文条件（scope=all 整句）
  const runRawSearch = () => { const text = aiInput.trim(); if (text) setQuery({ search: text }); };
  const keywordMode = parseStatus === "keyword";
  const partialMode = parseStatus === "partial" || (!keywordMode && warnings.length > 0);
  return <div className="flex flex-col gap-2">
    <h1 className="text-center text-sm font-medium tracking-wide text-[var(--color-text)]">超级搜索</h1>
    <form onSubmit={submit} className="relative">
      <input type="search" value={aiInput} onChange={(e) => setAiInput(e.target.value)} placeholder="搜索文件名、标签，或描述你想找的素材" className="ui-control h-12 w-full pl-4 pr-24 text-sm placeholder:text-[var(--color-text-secondary)]" aria-label="超级搜索" />
      <button type="submit" disabled={aiLoading || !aiInput.trim()} className="absolute inset-y-1.5 right-1.5 min-w-20 rounded bg-[var(--color-text)] px-3 text-xs font-medium text-[var(--color-bg)] transition-opacity hover:opacity-85 disabled:opacity-45">{aiLoading ? "解析中" : "搜索"}</button>
    </form>
    <div className="flex min-w-0 items-center gap-2 overflow-x-auto whitespace-nowrap text-[11px] text-[var(--color-text-tertiary)]">
      <span className="shrink-0">试试</span>
      {EXAMPLES.map((example) => <button key={example} type="button" onClick={() => setAiInput(example)} className="shrink-0 text-[var(--color-text-secondary)] hover:text-[var(--color-text)]">{example}</button>)}
    </div>
    {aiError ? (
      // 配置类错误（鉴权/连不上/超时）仍红字真报错（W6-2 例外）
      <div className="flex flex-wrap items-center gap-2 border-l-2 border-[var(--color-danger)] pl-2 text-[11px] leading-5 text-[var(--color-danger)]">
        <p className="min-w-0 flex-1">AI 解析失败：{aiError}</p>
        <button type="button" onClick={runRawSearch} className="shrink-0 rounded border border-[var(--color-border)] px-2 py-0.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]">
          按原文搜索
        </button>
      </div>
    ) : (aiExplanation || warnings.length > 0) && (
      // W6-5：黄字 warning 列表；三态解释文案
      <div className="border-l-2 pl-2 text-[11px] leading-5"
        style={{ borderColor: "var(--color-status)", color: "var(--color-text-secondary)" }}
      >
        {keywordMode ? (
          <p className="text-[var(--color-status)]">未能理解搜索条件，已按关键词搜索：{aiInput.trim()}</p>
        ) : partialMode ? (
          <p className="text-[var(--color-status)]">部分条件未能准确理解，已按能识别的部分搜索：{aiExplanation}</p>
        ) : aiExplanation ? (
          <p>AI 已转换为下方条件：{aiExplanation}</p>
        ) : null}
        {warnings.map((warning) => (
          <p key={warning} className="text-[var(--color-status)]">{warning}</p>
        ))}
      </div>
    )}
  </div>;
}

