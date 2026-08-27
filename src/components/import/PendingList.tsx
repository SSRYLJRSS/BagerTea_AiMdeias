/** 待入库清单（PRD v2.6）：列表/缩略图网格双视图，右上角图标切换
 *  性能：缩略图 IntersectionObserver 懒加载 + 模块级请求缓存，大清单不卡
 */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getPreviewUrl } from "@/api/preview";
import HoverPreviewTrigger from "@/components/media/HoverPreviewTrigger";
import ImagePreviewContent from "@/components/media/ImagePreviewContent";
import VideoPreviewContent from "@/components/media/VideoPreviewContent";
import type { ImportPlan, ImportPlanItem } from "@/api/import";

type ViewMode = "list" | "grid";

export function formatSize(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** 懒加载缩略图：进入视口才请求，淡入过渡；失败显示类型占位 */
function LazyThumb({ path, kind, className }: { path: string; kind: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ob = new IntersectionObserver(
      (es) => {
        if (es[0].isIntersecting) {
          setVisible(true);
          ob.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    ob.observe(el);
    return () => ob.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void getPreviewUrl(path).then((u) => {
      if (cancelled) return;
      if (u) setUrl(u);
      else setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [visible, path]);

  return (
    <div ref={ref} className={clsx("relative overflow-hidden bg-[var(--color-surface)]", className)}>
      {url && (
        <img
          src={url}
          alt=""
          onLoad={() => setLoaded(true)}
          className={clsx(
            "h-full w-full object-cover transition-opacity duration-300",
            loaded ? "opacity-100" : "opacity-0",
          )}
        />
      )}
      {(!url || failed) && (
        <div className="absolute inset-0 flex items-center justify-center text-[10px] text-[var(--color-text-secondary)]">
          {url === null && !failed ? "" : kind === "video" ? "视频" : "图片"}
        </div>
      )}
    </div>
  );
}

/** 待入库项悬浮预览内容：图片用 inspect 预览图；视频先封面、停留后原视频静音短播。
 *  只在浮层激活时渲染（按需请求，getPreviewUrl 有模块缓存）。 */
function PendingHover({ item }: { item: ImportPlanItem }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void getPreviewUrl(item.path).then((u) => {
      if (!cancelled) {
        if (!u) setFailed(true);
        setUrl(u);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [item.path]);
  const name = fileName(item.path);
  if (item.kind === "video") {
    return <VideoPreviewContent src={convertFileSrc(item.path)} coverUrl={failed ? null : url} fileName={name} />;
  }
  return <ImagePreviewContent url={failed ? null : url} placeholderUrl={url} fileName={name} />;
}

/* 苹果式简约图标：列表 / 网格 */
const ListIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <line x1="1" y1="3" x2="13" y2="3" />
    <line x1="1" y1="7" x2="13" y2="7" />
    <line x1="1" y1="11" x2="13" y2="11" />
  </svg>
);
const GridIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
    <rect x="1" y="1" width="5" height="5" rx="1" />
    <rect x="8" y="1" width="5" height="5" rx="1" />
    <rect x="1" y="8" width="5" height="5" rx="1" />
    <rect x="8" y="8" width="5" height="5" rx="1" />
  </svg>
);

interface PendingListProps {
  items: ImportPlan["items"];
  running: boolean;
  onRemove: (path: string) => void;
  /** 添加文件（页面上层调用 API，本组件不直接 invoke） */
  onAddFiles?: () => void;
  /** 添加文件夹（目录选择器） */
  onAddFolder?: () => void;
  onClear?: () => void;
}

export default function PendingList({ items, running, onRemove, onAddFiles, onAddFolder, onClear }: PendingListProps) {
  const [view, setView] = useState<ViewMode>("list");
  const totalSize = items.reduce((s, i) => s + i.size, 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-[var(--color-border)]">
      {/* 固定动作头部：添加文件/文件夹、视图切换、清空、数量与总大小。按钮不直接 invoke，事件交上层页面。 */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-2">
        <button
          type="button"
          onClick={onAddFiles}
          disabled={running}
          className="rounded px-1.5 py-1 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-40"
          title="添加文件"
          aria-label="添加文件"
        >
          + 添加文件
        </button>
        <button
          type="button"
          onClick={onAddFolder}
          disabled={running}
          className="rounded px-1.5 py-1 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-40"
          title="添加文件夹"
          aria-label="添加文件夹"
        >
          + 添加文件夹
        </button>
        <span className="ml-auto shrink-0 text-[11px] text-[var(--color-text-tertiary)]">
          {items.length} 项 · {formatSize(totalSize)}
        </span>
        <div className="flex overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]">
          {(
            [
              ["list", <ListIcon key="l" />],
              ["grid", <GridIcon key="g" />],
            ] as const
          ).map(([mode, icon]) => (
            <button
              key={mode}
              onClick={() => setView(mode)}
              title={mode === "list" ? "列表视图" : "缩略图视图"}
              aria-label={mode === "list" ? "列表视图" : "缩略图视图"}
              className={clsx(
                "flex h-6 w-8 items-center justify-center transition-colors duration-150",
                view === mode
                  ? "bg-[var(--color-accent)] text-[var(--color-accent-text)]"
                  : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]",
              )}
            >
              {icon}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onClear}
          disabled={running}
          className="rounded px-1.5 py-1 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-40"
          title="清空清单"
          aria-label="清空清单"
        >
          清空
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {view === "list" ? (
          <div>
            {items.map((i) => (
              <div
                key={i.path}
                className="flex items-center gap-2.5 border-b border-[var(--color-border)] px-3 py-1.5 text-sm transition-colors duration-150 last:border-b-0 hover:bg-[var(--color-surface)]"
              >
                <span className="shrink-0 rounded bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
                  {i.kind === "video" ? "视频" : "图片"}
                </span>
                <span className="min-w-0 flex-1 truncate text-[var(--color-text)]" title={i.path}>
                  {fileName(i.path)}
                </span>
                <span className="shrink-0 text-xs text-[var(--color-text-secondary)]">{formatSize(i.size)}</span>
                {!running && (
                  <button
                    aria-label="移除"
                    onClick={() => onRemove(i.path)}
                    className="shrink-0 text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-danger)]"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-2 p-2">
            {items.map((i) => (
              <HoverPreviewTrigger
                key={i.path}
                disabled={running}
                content={<PendingHover item={i} />}
              >
                <div className="group relative overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md">
                  <LazyThumb path={i.path} kind={i.kind} className="aspect-square w-full" />
                  <div className="flex items-center justify-between gap-1 px-1.5 py-1">
                    <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text)]" title={i.path}>
                      {fileName(i.path)}
                    </span>
                    <span className="shrink-0 text-[10px] text-[var(--color-text-secondary)]">{formatSize(i.size)}</span>
                  </div>
                  {i.kind === "video" && (
                    <span className="absolute top-1 left-1 rounded bg-black/55 px-1 py-0.5 text-[9px] text-white">视频</span>
                  )}
                  {!running && (
                    <button
                      aria-label="移除"
                      onClick={() => onRemove(i.path)}
                      className="absolute top-1 right-1 hidden h-5 w-5 items-center justify-center rounded-full bg-black/55 text-xs text-white transition-opacity group-hover:flex"
                    >
                      ×
                    </button>
                  )}
                </div>
              </HoverPreviewTrigger>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
