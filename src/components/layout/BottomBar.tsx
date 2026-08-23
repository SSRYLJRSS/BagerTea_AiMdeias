import clsx from "clsx";
import ProgressBar from "@/components/common/ProgressBar";
import { useTaskStore } from "@/stores/taskStore";

export type TabKey = "import" | "library" | "ai";

const TABS: { key: TabKey; label: string }[] = [
  { key: "import", label: "入库" },
  { key: "library", label: "素材库" },
  { key: "ai", label: "打标" },
];

interface BottomBarProps {
  current: TabKey | "settings";
  onNavigate: (tab: TabKey) => void;
}

/** 达芬奇式底栏：3 个纯文字按钮、整体居中、无图标无副标题（PRD R-13）
 *  M3-04：左侧追加全局任务条（入库/导出/AI 打标进度聚合，只读既有事件） */
export default function BottomBar({ current, onNavigate }: BottomBarProps) {
  const tasks = useTaskStore((s) => s.tasks);

  return (
    <nav className="fixed bottom-0 inset-x-0 h-14 flex items-center justify-center gap-12 border-t border-[var(--color-border)] bg-[var(--color-bg)]">
      {/* 全局任务条（有进行中任务才显示） */}
      {tasks.length > 0 && (
        <div className="absolute left-3 flex flex-col gap-1">
          {tasks.map((t) => (
            <div key={t.key} className="flex w-44 items-center gap-2">
              <span className="shrink-0 text-[10px] text-[var(--color-text-secondary)]">{t.label}</span>
              <ProgressBar value={t.total ? t.done / t.total : 0} className="h-1 flex-1" />
              <span className="shrink-0 text-[10px] text-[var(--color-text-secondary)]">
                {t.done}/{t.total}
              </span>
            </div>
          ))}
        </div>
      )}

      {TABS.map((tab) => (
        <button
          key={tab.key}
          onClick={() => onNavigate(tab.key)}
          className={clsx(
            "text-sm tracking-widest pb-0.5 border-b-2 transition-colors",
            current === tab.key
              ? "text-[var(--color-accent)] border-[var(--color-accent)]"
              : "text-[var(--color-text-secondary)] border-transparent hover:text-[var(--color-text)]",
          )}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
