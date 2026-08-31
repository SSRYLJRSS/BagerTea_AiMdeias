/** 入库页（PRD v2.6 编排层；阶段 1 改造）：左侧任务栏 + 右侧拖拽区/清单。
 *  页面只保留结果摘要（当前文件/成功/重复/失败/阶段），不再绘制第二条进度条——
 *  统一进度条由底栏上方任务层（taskStore 驱动）承担。 */
import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { open as pickFiles, open as pickDir } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import Button from "@/components/common/Button";
import PendingList, { formatSize } from "@/components/import/PendingList";
import RenameBuilder from "@/components/import/RenameBuilder";
import { openFileExternal } from "@/api/import";
import {
  cancelImport,
  importFiles,
  inspectImport,
  onImportProgress,
  type ImportPlan,
  type ImportProgress,
} from "@/api/import";
import { useLibraryStore } from "@/stores/libraryStore";
import { useMetadataStore } from "@/stores/metadataStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { markImportCancelling } from "@/stores/taskStore";
import type { ImportResult } from "@/types/asset";

// 与后端 utils/mime.rs asset_type_from_ext 白名单同步（选择器过滤，拖拽入口由后端扫描过滤）
const FILE_FILTERS = [
  {
    name: "图片与视频",
    extensions: [
      "jpg", "jpeg", "png", "gif", "webp", "bmp", "tga", "tif", "tiff", "heic", "heif",
      "raw", "cr2", "cr3", "crw", "nef", "nrw", "arw", "srf", "sr2", "dng",
      "raf", "orf", "rw2", "pef", "srw", "x3f", "mrw", "iiq", "3fr", "fff",
      "kdc", "dcr", "mos", "mef", "erf",
      "mp4", "mov", "avi", "mkv", "webm", "m4v", "mts", "m2ts",
    ],
  },
];

export default function ImportPage() {
  const refreshLibrary = useLibraryStore((s) => s.refresh);
  const libraryRoot = useSettingsStore((s) => s.settings?.libraryRoot ?? "");
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const loadSettings = useSettingsStore((s) => s.load);

  const [plan, setPlan] = useState<ImportPlan | null>(null);
  // W5f-f2：导入失败明细展开状态
  const [showImportErrors, setShowImportErrors] = useState(false);
  const [collection, setCollection] = useState("");
  const [renamePattern, setRenamePattern] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!settingsLoaded) void loadSettings();
  }, [settingsLoaded, loadSettings]);

  /** 选文件/拖文件 → 只生成清单，不入库（PRD v2.4 手动确认）；追加期间保留旧清单 */
  const stage = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0 || running) return;
      setError(null);
      setResult(null);
      try {
        const scanned = await inspectImport(paths);
        if (scanned.items.length === 0) {
          setError("未发现可入库的图片/视频文件");
          return;
        }
        // 追加合并（按规范化路径去重；哈希去重由正式入库兜底）
        setPlan((prev) => {
          if (!prev) return scanned;
          const known = new Set(prev.items.map((i) => i.path));
          const fresh = scanned.items.filter((i) => !known.has(i.path));
          const items = [...prev.items, ...fresh];
          return {
            items,
            images: items.filter((i) => i.kind === "image").length,
            videos: items.filter((i) => i.kind === "video").length,
            totalSize: items.reduce((s, i) => s + i.size, 0),
          };
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [running],
  );

  // 阶段 1：页面只保留结果摘要（当前文件/计数/阶段），不绘制进度条。
  // 进度事件仍订阅用于汇总文本；统一进度条由 taskStore/底栏任务层承担。
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    onImportProgress(setProgress).then((fn) => {
      if (cancelled) fn();
      else un = fn;
    });
    return () => {
      cancelled = true;
      un?.();
    };
  }, []);

  // Tauri 原生拖拽（获取真实文件路径）
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    getCurrentWebview()
      .onDragDropEvent((e) => {
        if (e.payload.type === "over") setDragOver(true);
        else if (e.payload.type === "leave") setDragOver(false);
        else if (e.payload.type === "drop") {
          setDragOver(false);
          void stage(e.payload.paths);
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else un = fn;
      });
    return () => {
      cancelled = true;
      un?.();
    };
  }, [stage]);

  const choose = async () => {
    if (running) return;
    const picked = await pickFiles({ multiple: true, filters: FILE_FILTERS });
    if (Array.isArray(picked)) void stage(picked);
    else if (typeof picked === "string") void stage([picked]);
  };

  /** 添加文件夹：目录选择器，同样走 stage(paths) */
  const chooseFolder = async () => {
    if (running) return;
    const picked = await pickDir({ directory: true, multiple: true });
    if (picked && Array.isArray(picked)) void stage(picked);
    else if (typeof picked === "string") void stage([picked]);
  };

  const removeItem = (path: string) =>
    setPlan((prev) => {
      if (!prev) return prev;
      const items = prev.items.filter((i) => i.path !== path);
      return {
        items,
        images: items.filter((i) => i.kind === "image").length,
        videos: items.filter((i) => i.kind === "video").length,
        totalSize: items.reduce((s, i) => s + i.size, 0),
      };
    });

  const clearPlan = () => {
    if (running) return;
    setPlan(null);
  };

  /** 手动确认入库 */
  const run = async () => {
    if (!plan || plan.items.length === 0 || running) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const r = await importFiles(
        plan.items.map((i) => i.path),
        { collection: collection.trim() || undefined, renamePattern: renamePattern.trim() || undefined },
      );
      setResult(r);
      setPlan(null);
      void refreshLibrary();
      void useMetadataStore.getState().refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  return (
    <div className="flex h-full">
      {/* 左侧任务栏：统计 + 选项 + 开始/清空（运行中改为取消） */}
      <aside className="flex w-[180px] shrink-0 flex-col border-r border-[var(--color-border)]">
        <div className="border-b border-[var(--color-border)] p-3">
          <h3 className="mb-2 text-xs font-medium tracking-wide text-[var(--color-text-secondary)] uppercase">
            待入库清单
          </h3>
          <div className="flex flex-col gap-1 text-sm text-[var(--color-text)]">
            <span>图片 {plan?.images ?? 0} 张</span>
            <span>视频 {plan?.videos ?? 0} 个</span>
            <span className="text-xs text-[var(--color-text-secondary)]">
              共 {plan?.items.length ?? 0} 项 · {formatSize(plan?.totalSize ?? 0)}
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-3 p-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-[var(--color-text-secondary)]">
              分库名称{libraryRoot ? "（总库下新建文件夹）" : "（需先在设置里配置总库）"}
            </span>
            <input
              value={collection}
              onChange={(e) => setCollection(e.target.value)}
              disabled={!libraryRoot}
              placeholder="如：旅行"
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)] disabled:opacity-40"
            />
          </label>
          <RenameBuilder
            value={renamePattern}
            onChange={setRenamePattern}
            disabled={!libraryRoot}
            collection={collection.trim()}
            sampleStem={plan?.items[0]?.path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? ""}
            sampleExt={plan?.items[0]?.path.split(".").pop() ?? ""}
          />
        </div>

        {plan && plan.items.length > 0 && (
          <div className="mt-auto p-3">
            {running ? (
              <Button
                className="w-full"
                onClick={() => {
                  markImportCancelling();
                  void cancelImport();
                }}
              >
                取消入库
              </Button>
            ) : (
              <>
                <Button variant="primary" className="w-full" onClick={() => void run()}>
                  开始入库（{plan.items.length}）
                </Button>
                <Button className="mt-1 w-full" onClick={clearPlan}>
                  清空清单
                </Button>
              </>
            )}
          </div>
        )}
      </aside>

      {/* 右侧：拖拽区 / 清单 + 结果摘要（不绘制进度条） */}
      <div className="flex min-w-0 flex-1 flex-col p-6">
        {/* 结果摘要：当前文件 + 成功/重复/失败 + 阶段（不是进度条） */}
        {(progress || result) && (
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--color-text-secondary)]">
            {progress && progress.file && (
              <span className="truncate text-[var(--color-text)]" title={progress.file}>
                当前文件：{progress.file}
              </span>
            )}
            {result ? (
              <span>
                成功 {result.imported} · 重复 {result.duplicates} · 失败 {result.failed}
              </span>
            ) : (
              <span>
                成功 {progress?.imported ?? 0} · 重复 {progress?.duplicates ?? 0} · 失败 {progress?.failed ?? 0}
              </span>
            )}
            {progress && progress.message && <span>阶段：{progress.message}</span>}
          </div>
        )}
        {/* W5f-f2：导入失败明细 —— 首行摘要 + 可展开全量清单 */}
        {result && result.errors.length > 0 && (
          <div className="mb-3 max-w-lg text-xs text-[var(--color-danger)]">
            <button
              type="button"
              onClick={() => setShowImportErrors((v) => !v)}
              className="text-left"
            >
              失败 {result.errors.length} 个{showImportErrors ? "（收起明细）" : "（展开明细）"}
            </button>
            {showImportErrors && (
              <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto rounded-md bg-[var(--color-surface)] p-2">
                {result.errors.map((e, i) => (
                  <li key={i} className="break-all">{e}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {error && !running && <p className="mb-3 text-xs text-[var(--color-danger)]">{error}</p>}

        {plan && plan.items.length > 0 ? (
          <PendingList
            items={plan.items}
            running={running}
            onRemove={removeItem}
            onAddFiles={choose}
            onAddFolder={chooseFolder}
            onClear={clearPlan}
            onOpenItem={(p) => void openFileExternal(p).catch(() => undefined)}
          />
        ) : (
          <div
            className={clsx(
              "flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed transition-colors",
              dragOver ? "border-[var(--color-accent)] bg-[var(--color-surface)]" : "border-[var(--color-border)]",
            )}
          >
            <p className="text-base text-[var(--color-text)]">把图片 / 视频拖到这里</p>
            <p className="text-sm text-[var(--color-text-secondary)]">
              支持文件夹递归，重复文件自动识别；选中后先入清单，手动确认才入库
            </p>
            {!running && (
              <div className="flex gap-2">
                <Button variant="primary" onClick={choose}>
                  选择文件…
                </Button>
                <Button onClick={chooseFolder}>选择文件夹…</Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
