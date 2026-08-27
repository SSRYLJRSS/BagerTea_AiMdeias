/** 超级搜索唯一主输入框：普通关键词与自然语言条件统一从这里进入。 */
import { FormEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { useSuperSearchStore } from "@/stores/superSearchStore";

const EXAMPLES = ["2025 年拍的横图海边素材，大于 5MB", "Sony 拍的视频，时长 10 秒以上", "清新的竖版人像，不要夜景"];

interface AiSearchBarProps { onSubmit: (text: string) => void; }

export default function AiSearchBar({ onSubmit }: AiSearchBarProps) {
  const { aiInput, setAiInput, aiLoading, aiExplanation, warnings } = useSuperSearchStore(useShallow((s) => ({ aiInput: s.aiInput, setAiInput: s.setAiInput, aiLoading: s.aiLoading, aiExplanation: s.aiExplanation, warnings: s.warnings })));
  const submit = (event?: FormEvent) => { event?.preventDefault(); const text = aiInput.trim(); if (text) onSubmit(text); };
  return <div className="flex flex-col gap-2">
    <form onSubmit={submit} className="relative">
      <input type="search" value={aiInput} onChange={(e) => setAiInput(e.target.value)} placeholder="搜索文件名、标签，或描述你想找的素材" className="ui-control h-12 w-full pl-4 pr-24 text-sm placeholder:text-[var(--color-text-secondary)]" aria-label="超级搜索" />
      <button type="submit" disabled={aiLoading || !aiInput.trim()} className="absolute inset-y-1.5 right-1.5 min-w-20 rounded bg-[var(--color-text)] px-3 text-xs font-medium text-[var(--color-bg)] transition-opacity hover:opacity-85 disabled:opacity-45">{aiLoading ? "解析中" : "搜索"}</button>
    </form>
    <div className="flex min-w-0 items-center gap-2 overflow-x-auto whitespace-nowrap text-[11px] text-[var(--color-text-tertiary)]">
      <span className="shrink-0">试试</span>
      {EXAMPLES.map((example) => <button key={example} type="button" onClick={() => setAiInput(example)} className="shrink-0 text-[var(--color-text-secondary)] hover:text-[var(--color-text)]">{example}</button>)}
    </div>
    {(aiExplanation || warnings.length > 0) && <div className="border-l-2 border-[var(--color-status)] pl-2 text-[11px] leading-5 text-[var(--color-text-secondary)]">{aiExplanation && <p>AI 已转换为下方条件：{aiExplanation}</p>}{warnings.map((warning) => <p key={warning} className="text-[var(--color-status)]">{warning}</p>)}</div>}
  </div>;
}
