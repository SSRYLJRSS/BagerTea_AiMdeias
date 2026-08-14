import clsx from "clsx";

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

/** 达芬奇式底栏：3 个纯文字按钮、整体居中、无图标无副标题（PRD R-13） */
export default function BottomBar({ current, onNavigate }: BottomBarProps) {
  return (
    <nav className="fixed bottom-0 inset-x-0 h-14 flex items-center justify-center gap-12 border-t border-[var(--color-border)] bg-[var(--color-bg)]">
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
