import { useEffect, useState } from "react";
import BottomBar, { type TabKey } from "@/components/layout/BottomBar";
import ImportPage from "@/pages/ImportPage";
import LibraryPage from "@/pages/LibraryPage";
import AiTaggingPage from "@/pages/AiTaggingPage";
import SettingsPage from "@/pages/SettingsPage";
import { startGlobalTaskWatch } from "@/stores/taskStore";
import { useSettingsStore } from "@/stores/settingsStore";

type PageKey = TabKey | "settings";

/** 路由骨架：4 页 + 全局底栏（设置页走左上角入口，底栏仅 3 个主入口） */
export default function App() {
  const [page, setPage] = useState<PageKey>("library");
  // 进入设置前的页面，再点「设置」返回（PRD v2.4）
  const [prevPage, setPrevPage] = useState<PageKey>("library");

  // 库页操作区/上下文条的跨页导航（导入、AI 打标）
  useEffect(() => {
    const onNav = (e: Event) => setPage((e as CustomEvent<PageKey>).detail);
    window.addEventListener("app:navigate", onNav);
    return () => window.removeEventListener("app:navigate", onNav);
  }, []);

  // 全局任务条：订阅入库/导出/AI 进度事件（幂等，M3-04）
  useEffect(() => {
    void startGlobalTaskWatch();
  }, []);

  // R-24：启动即加载设置并应用主题（load 内部调 applyTheme）
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const loadSettings = useSettingsStore((s) => s.load);
  useEffect(() => {
    if (!settingsLoaded) void loadSettings();
  }, [settingsLoaded, loadSettings]);

  return (
    <div className="h-full flex flex-col">
      <header className="h-11 shrink-0 flex items-center px-4 border-b border-[var(--color-border)]">
        <button
          onClick={() => {
            if (page === "settings") setPage(prevPage);
            else {
              setPrevPage(page);
              setPage("settings");
            }
          }}
          className="text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
        >
          设置
        </button>
      </header>

      <main className="flex-1 min-h-0 pb-14">
        {page === "import" && <ImportPage />}
        {page === "library" && <LibraryPage />}
        {page === "ai" && <AiTaggingPage />}
        {page === "settings" && <SettingsPage />}
      </main>

      <BottomBar current={page} onNavigate={setPage} />
    </div>
  );
}
