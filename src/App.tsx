import { useEffect, useRef, useState } from "react";
import BottomBar, { type TabKey } from "@/components/layout/BottomBar";
import TitleBar from "@/components/layout/TitleBar";
import StartupSkeleton from "@/components/common/StartupSkeleton";
import ImportPage from "@/pages/ImportPage";
import LibraryPage from "@/pages/LibraryPage";
import SuperSearchPage from "@/pages/SuperSearchPage";
import AiTaggingPage from "@/pages/AiTaggingPage";
import SettingsPage from "@/pages/SettingsPage";
import PageErrorBoundary from "@/components/common/PageErrorBoundary";
import { startGlobalTaskWatch } from "@/stores/taskStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useLibraryStore } from "@/stores/libraryStore";
import { markStartup } from "@/utils/startupMarks";

type PageKey = TabKey | "settings" | "superSearch";

/** 首屏骨架最长等待：设置/素材 IPC 若异常挂起，最多等这么久就放行页面（§3.2 超时兜底） */
const STARTUP_MAX_WAIT_MS = 6000;

/** 路由骨架：4 页 + 全局底栏（设置入口位于库页顶栏左侧，底栏仅 3 个主入口） */
export default function App() {
  const [page, setPage] = useState<PageKey>("library");
  // 进入设置前的页面，供设置页「返回」恢复（PRD v2.4）
  const [prevPage, setPrevPage] = useState<PageKey>("library");
  const [startupTimedOut, setStartupTimedOut] = useState(false);
  const pageRef = useRef<PageKey>("library");
  useEffect(() => {
    pageRef.current = page;
  }, [page]);

  // 库页操作区/上下文条的跨页导航（导入、AI 打标、设置）
  useEffect(() => {
    const onNav = (e: Event) => {
      const next = (e as CustomEvent<PageKey>).detail;
      if (needsPrev(next) && pageRef.current !== next) setPrevPage(pageRef.current);
      setPage(next);
    };
    window.addEventListener("app:navigate", onNav);
    return () => window.removeEventListener("app:navigate", onNav);
  }, []);

  // 需要记录进入前页面以便返回的页：设置、超级搜索
  const needsPrev = (next: PageKey) => next === "settings" || next === "superSearch";

  // 导航入口：底栏 + 超级搜索双击
  const navigate = (next: PageKey) => {
    if (needsPrev(next) && pageRef.current !== next) setPrevPage(pageRef.current);
    setPage(next);
  };

  // 全局任务条：订阅入库/导出/AI 进度事件（幂等，M3-04）
  useEffect(() => {
    void startGlobalTaskWatch();
  }, []);

  // R-24：启动即加载设置并应用主题（load 内部调 applyTheme；single-flight 见 settingsStore §5.3）
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const loadSettings = useSettingsStore((s) => s.load);
  useEffect(() => {
    markStartup("react_first_render"); // §4.1：React 首帧打点（首次挂载即首帧）
    if (!settingsLoaded) void loadSettings();
  }, [settingsLoaded, loadSettings]);

  // 骨架超时兜底：设置 IPC 异常挂起时不可无限停留在过渡态（§3.2）
  useEffect(() => {
    const t = setTimeout(() => setStartupTimedOut(true), STARTUP_MAX_WAIT_MS);
    return () => clearTimeout(t);
  }, []);

  // §7.3 方案 A：Viewer 打开时隐藏全局 BottomBar（Viewer 自带胶片条，避免双重导航）
  const viewerOpen = useLibraryStore((s) => s.viewerOpen);

  const showSkeleton = !settingsLoaded && !startupTimedOut;

  return (
    <div className="h-full flex flex-col">
      <TitleBar />

      <main className={viewerOpen ? "flex-1 min-h-0" : "flex-1 min-h-0 pb-14"}>
        {showSkeleton ? (
          <StartupSkeleton />
        ) : (
          /* A-1：页面级 Error Boundary——路由页运行时异常不白屏；key 切换让每个页面独立边界 */
          <PageErrorBoundary key={page} onReset={() => setPage(page)} onBack={() => setPage("library")}>
            {page === "import" && <ImportPage />}
            {page === "library" && <LibraryPage />}
            {page === "superSearch" && <SuperSearchPage onBack={() => setPage(prevPage)} />}
            {page === "ai" && <AiTaggingPage />}
            {page === "settings" && <SettingsPage onBack={() => setPage(prevPage)} />}
          </PageErrorBoundary>
        )}
      </main>

      {!viewerOpen && (
        <BottomBar current={page} onNavigate={navigate} onOpenSuperSearch={() => navigate("superSearch")} />
      )}
    </div>
  );
}