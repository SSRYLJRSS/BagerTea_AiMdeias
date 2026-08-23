/** 全屏查看器（PRD v2.9）：双击进入的不透明新界面
 *  布局：大图区（缩放/平移）→ 信息栏 → 缩略图胶片条
 *  交互：Alt+滚轮以光标为锚缩放、中键拖拽平移、按住右键临时放大松开恢复、←→ 过片、Esc 退出
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useShallow } from "zustand/react/shallow";
import TagChip from "@/components/library/TagChip";
import TagAssignDialog from "@/components/dialogs/TagAssignDialog";
import { getThumbnailUrl, toFileUrl } from "@/api/thumbnail";
import { removeTags } from "@/api/tags";
import { useLibraryStore } from "@/stores/libraryStore";
import { useSelectionStore } from "@/stores/selectionStore";
import type { Asset } from "@/types/asset";

const ZOOM_MIN = 0.2;
const ZOOM_MAX = 10;
const RIGHT_HOLD_ZOOM = 2.5;

function formatSize(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

function exifLine(a: Asset): string {
  const parts: string[] = [];
  if (a.camera) parts.push(a.camera);
  if (a.lens) parts.push(a.lens);
  if (a.aperture != null) parts.push(`f/${a.aperture}`);
  if (a.shutter) parts.push(`${a.shutter}s`);
  if (a.iso != null) parts.push(`ISO${a.iso}`);
  if (a.focal != null) parts.push(`${a.focal}mm`);
  return parts.join(" · ");
}

interface ViewerPageProps {
  asset: Asset;
  onClose: () => void;
}

export default function ViewerPage({ asset: initial, onClose }: ViewerPageProps) {
  const { items, total, loadMore, patchLocal } = useLibraryStore(
    useShallow((s) => ({ items: s.items, total: s.total, loadMore: s.loadMore, patchLocal: s.patchLocal })),
  );
  const [currentId, setCurrentId] = useState(initial.id);
  const current: Asset = useMemo(
    () => items.find((a) => a.id === currentId) ?? initial,
    [items, currentId, initial],
  );
  const index = useMemo(() => items.findIndex((a) => a.id === currentId), [items, currentId]);

  // 缩放/平移状态
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const savedView = useRef<{ scale: number; pan: { x: number; y: number } } | null>(null);
  const panDrag = useRef<{ x: number; y: number } | null>(null);
  // 左键双击并按住放大：记录上一次左键按下时间，快速二次按下判定为双击
  const lastLeftDown = useRef(0);
  const holdLast = useRef<{ x: number; y: number } | null>(null); // 按住放大期间的拖拽轨迹
  const stageRef = useRef<HTMLDivElement>(null);

  const [src, setSrc] = useState<string | null>(null);
  const [entered, setEntered] = useState(false);

  // 详情抽屉（M3-03 R-18）：标签增删 + 元数据面板，ViewerPage 内部状态切换不新建路由
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const prevSelected = useRef<ReadonlySet<number> | null>(null);

  const openAssign = () => {
    // TagAssignDialog 基于选中集工作：暂存原选中，换为当前单张，关闭时恢复
    prevSelected.current = useSelectionStore.getState().selected;
    useSelectionStore.setState({ selected: new Set([current.id]) });
    setAssignOpen(true);
  };

  const closeAssign = () => {
    setAssignOpen(false);
    if (prevSelected.current) useSelectionStore.setState({ selected: prevSelected.current });
    prevSelected.current = null;
  };

  const removeTag = async (tagId: number) => {
    try {
      await removeTags([current.id], [tagId]);
      patchLocal([current.id], { tags: current.tags.filter((t) => t.id !== tagId) });
    } catch {
      /* 失败保持现状，下次打开抽屉仍可重试 */
    }
  };

  // 进场动画
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // 切张：重置视图 + 加载高清（失败退原图）
  useEffect(() => {
    setScale(1);
    setPan({ x: 0, y: 0 });
    setSrc(null);
    let cancelled = false;
    getThumbnailUrl(current.id, "hd", 1920)
      .then((u) => !cancelled && setSrc(u))
      .catch(() => !cancelled && setSrc(toFileUrl(current.filePath)));
    return () => {
      cancelled = true;
    };
  }, [current.id, current.filePath]);

  // 过片（近尾部自动翻页加载）
  const goto = useCallback(
    (next: number) => {
      if (items.length === 0) return;
      const clamped = Math.max(0, Math.min(next, items.length - 1));
      if (items[clamped]) setCurrentId(items[clamped].id);
      if (clamped >= items.length - 5 && items.length < total) void loadMore();
    },
    [items, total, loadMore],
  );

  // 以光标为锚缩放
  const zoomAt = useCallback((clientX: number, clientY: number, nextRaw: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const next = Math.max(ZOOM_MIN, Math.min(nextRaw, ZOOM_MAX));
    const cx = clientX - (rect.left + rect.width / 2);
    const cy = clientY - (rect.top + rect.height / 2);
    setPan((p) => {
      setScale((s) => {
        const imgX = (cx - p.x) / s;
        const imgY = (cy - p.y) / s;
        p = { x: cx - imgX * next, y: cy - imgY * next };
        return next;
      });
      return p;
    });
  }, []);

  // 滚轮：React onWheel 拦不住默认行为，必须原生 passive:false
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.altKey) return;
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [scale, zoomAt]);

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1) {
      // 中键平移
      e.preventDefault();
      panDrag.current = { x: e.clientX, y: e.clientY };
    } else if (e.button === 0) {
      // 左键双击并按住：快速二次按下 → 以光标为中心临时放大，松开恢复
      const now = Date.now();
      if (now - lastLeftDown.current < 300 && e.detail === 2) {
        savedView.current = { scale, pan };
        holdLast.current = { x: e.clientX, y: e.clientY };
        zoomAt(e.clientX, e.clientY, RIGHT_HOLD_ZOOM);
      }
      lastLeftDown.current = now;
    }
  };

  const onMouseMove = (e: React.MouseEvent) => {
    // 按住放大态：左键按下拖动 → 图片跟着移动看细节
    if (savedView.current) {
      if (holdLast.current) {
        const dx = e.clientX - holdLast.current.x;
        const dy = e.clientY - holdLast.current.y;
        holdLast.current = { x: e.clientX, y: e.clientY };
        setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
      } else {
        holdLast.current = { x: e.clientX, y: e.clientY };
      }
      return;
    }
    if (!panDrag.current) return;
    const dx = e.clientX - panDrag.current.x;
    const dy = e.clientY - panDrag.current.y;
    panDrag.current = { x: e.clientX, y: e.clientY };
    setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
  };

  const onMouseUp = (e: React.MouseEvent) => {
    if (e.button === 1) {
      panDrag.current = null;
    } else if (e.button === 0 && savedView.current) {
      // 左键松开 → 恢复原视图
      setScale(savedView.current.scale);
      setPan(savedView.current.pan);
      savedView.current = null;
      holdLast.current = null;
    }
  };

  // 键盘：←→ 过片，Esc 退出
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") goto(index - 1);
      else if (e.key === "ArrowRight") goto(index + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, goto, onClose]);

  const isVideo = current.durationMs != null;
  const exif = exifLine(current);

  return (
    <div
      className={clsx(
        "fixed inset-0 z-50 flex flex-col bg-[var(--color-bg)] transition-all duration-200 ease-out",
        entered ? "scale-100 opacity-100" : "scale-[0.98] opacity-0",
      )}
    >
      {/* 顶行：文件名 + 位置 + 关闭 */}
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-[var(--color-border)] px-3">
        <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-text)]">{current.fileName}</span>
        <span className="shrink-0 text-xs text-[var(--color-text-secondary)]">
          {index >= 0 ? `${index + 1} / ${total}` : ""}
        </span>
        <button
          onClick={() => setDrawerOpen((v) => !v)}
          className={clsx(
            "shrink-0 rounded-md px-2 py-1 text-sm transition-colors hover:bg-[var(--color-surface)]",
            drawerOpen
              ? "text-[var(--color-text)]"
              : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]",
          )}
        >
          详情
        </button>
        <button
          onClick={onClose}
          className="shrink-0 rounded-md px-2 py-1 text-sm text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
        >
          关闭（Esc）
        </button>
      </div>

      {/* 大图区 */}
      <div
        ref={stageRef}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={() => {
          holdLast.current = null;
        }}
        onContextMenu={(e) => e.preventDefault()}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[var(--color-bg)]"
      >
        {isVideo ? (
          <video src={convertFileSrc(current.filePath)} controls autoPlay className="max-h-full max-w-full" />
        ) : src ? (
          <img
            key={current.id}
            src={src}
            alt={current.fileName}
            draggable={false}
            onError={() => {
              const orig = toFileUrl(current.filePath);
              if (src !== orig) setSrc(orig);
            }}
            className="max-h-full max-w-full object-contain select-none"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
              transition: panDrag.current || savedView.current ? "none" : "transform 120ms ease-out",
            }}
          />
        ) : (
          <div className="h-32 w-32 animate-pulse rounded bg-[var(--color-border)]" />
        )}
        {scale !== 1 && (
          <span className="absolute top-2 right-3 rounded bg-black/50 px-2 py-0.5 text-xs text-white">
            {Math.round(scale * 100)}%
          </span>
        )}
      </div>

      {/* 信息栏 */}
      <div className="flex shrink-0 items-center gap-3 border-t border-[var(--color-border)] px-3 py-1.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {current.tags.map((t) => (
            <TagChip key={t.id} label={t.name} />
          ))}
          {current.tags.length === 0 && <span className="text-xs text-[var(--color-text-secondary)]">未打标</span>}
        </div>
        {exif && <span className="shrink-0 text-[11px] text-[var(--color-text-secondary)]">{exif}</span>}
        <span className="shrink-0 text-[11px] text-[var(--color-text-secondary)]">
          {current.width && current.height ? `${current.width}×${current.height} · ` : ""}
          {formatSize(current.fileSize)} · {current.mimeType}
        </span>
      </div>

      {/* 缩略图胶片条 */}
      <div className="flex shrink-0 gap-1.5 overflow-x-auto border-t border-[var(--color-border)] px-3 py-2">
        {items.map((a, i) => (
          <button
            key={a.id}
            onClick={() => goto(i)}
            className={clsx(
              "h-14 w-14 shrink-0 overflow-hidden rounded border-2 transition-all",
              a.id === currentId
                ? "border-[var(--color-accent)]"
                : "border-transparent opacity-70 hover:opacity-100",
            )}
          >
            {a.placeholderPath ? (
              <img src={convertFileSrc(a.placeholderPath)} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-[var(--color-surface)] text-[9px] text-[var(--color-text-secondary)]">
                {a.durationMs != null ? "视频" : "图片"}
              </div>
            )}
          </button>
        ))}
      </div>

      {/* 详情抽屉（M3-03）：标签增删 + 元数据面板（信息分组借鉴 Lightroom 检查器：文件/EXIF/标签三段） */}
      {drawerOpen && (
        <div className="absolute top-10 right-0 bottom-0 z-10 w-[300px] overflow-y-auto border-l border-[var(--color-border)] bg-[var(--color-bg)] p-3">
          {/* 标签 */}
          <section className="mb-4">
            <h4 className="mb-1.5 text-[10px] font-medium tracking-wide text-[var(--color-text-secondary)] uppercase">标签</h4>
            <div className="flex flex-wrap items-center gap-1.5">
              {current.tags.map((t) => (
                <TagChip key={t.id} label={t.name} onRemove={() => void removeTag(t.id)} />
              ))}
              {current.tags.length === 0 && (
                <span className="text-xs text-[var(--color-text-secondary)]">未打标</span>
              )}
            </div>
            <button
              onClick={openAssign}
              className="mt-2 rounded-md border border-dashed border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
            >
              + 添加标签
            </button>
          </section>

          {/* 文件 */}
          <section className="mb-4">
            <h4 className="mb-1.5 text-[10px] font-medium tracking-wide text-[var(--color-text-secondary)] uppercase">文件</h4>
            <dl className="flex flex-col gap-1 text-xs">
              <MetaRow label="名称" value={current.fileName} />
              <MetaRow label="路径" value={current.filePath} />
              <MetaRow label="大小" value={formatSize(current.fileSize)} />
              <MetaRow label="类型" value={current.mimeType} />
              {current.width != null && current.height != null && (
                <MetaRow label="分辨率" value={`${current.width}×${current.height}`} />
              )}
              <MetaRow label="入库时间" value={formatTime(current.createdAt)} />
              {current.durationMs != null && (
                <>
                  <MetaRow label="时长" value={formatDuration(current.durationMs)} />
                  {current.videoCodec && <MetaRow label="视频编码" value={current.videoCodec} />}
                  {current.audioCodec && <MetaRow label="音频编码" value={current.audioCodec} />}
                </>
              )}
            </dl>
          </section>

          {/* EXIF（入库时已提取进 assets 表，直读） */}
          {(current.camera || current.lens || current.aperture != null || current.shutter ||
            current.iso != null || current.focal != null || current.takenAt != null) && (
              <section>
                <h4 className="mb-1.5 text-[10px] font-medium tracking-wide text-[var(--color-text-secondary)] uppercase">EXIF</h4>
                <dl className="flex flex-col gap-1 text-xs">
                  {current.takenAt != null && <MetaRow label="拍摄时间" value={formatTime(current.takenAt)} />}
                  {current.camera && <MetaRow label="机身" value={current.camera} />}
                  {current.lens && <MetaRow label="镜头" value={current.lens} />}
                  {current.aperture != null && <MetaRow label="光圈" value={`f/${current.aperture}`} />}
                  {current.shutter && <MetaRow label="快门" value={`${current.shutter}s`} />}
                  {current.iso != null && <MetaRow label="ISO" value={String(current.iso)} />}
                  {current.focal != null && <MetaRow label="焦距" value={`${current.focal}mm`} />}
                </dl>
              </section>
            )}
        </div>
      )}

      <TagAssignDialog open={assignOpen} onClose={closeAssign} />
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-14 shrink-0 text-[var(--color-text-secondary)]">{label}</dt>
      <dd className="min-w-0 flex-1 break-all text-[var(--color-text)]">{value}</dd>
    </div>
  );
}
