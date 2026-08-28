/** 查看器（指导书 §4.1）：ViewerPage 只负责当前素材、上一张/下一张、打开/关闭、组合子组件与错误边界。
 *  布局由 ViewerShell 承载：工具条（固定）→ 左属性栏 + 右媒体舞台 → 底部胶片条。
 *  标题栏在查看器外层始终可见（不再 fixed inset-0 覆盖标题栏）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useShallow } from "zustand/react/shallow";
import ViewerShell from "@/components/viewer/ViewerShell";
import ViewerToolbar from "@/components/viewer/ViewerToolbar";
import ViewerInfoSidebar from "@/components/viewer/ViewerInfoSidebar";
import ViewerFilmstrip from "@/components/viewer/ViewerFilmstrip";
import MediaViewport from "@/components/viewer/MediaViewport";
import VideoPlayer from "@/components/media/VideoPlayer";
import TagAssignDialog from "@/components/dialogs/TagAssignDialog";
import { getThumbnailUrl, toFileUrl } from "@/api/thumbnail";
import { removeTags } from "@/api/tags";
import { ensureVideoProxy, cancelVideoProxy, toProxyFileUrl } from "@/api/video";
import { useLibraryStore } from "@/stores/libraryStore";
import { useSelectionStore } from "@/stores/selectionStore";
import { isVideoAsset } from "@/utils/assetKind";
import type { Asset } from "@/types/asset";

interface ViewerPageProps {
  asset: Asset;
  onClose: () => void;
}

/** §4.3 页面键盘白名单：输入框/下拉/文本域/contentEditable 不响应页面级快捷键 */
function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  return el.isContentEditable;
}

/** 焦点是否在播放器根节点或其子节点（§4.3：播放器键盘作用域优先于页面切片） */
function isInsidePlayer(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el?.closest?.("[data-player-root]");
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

  // 图片高清源（代际保护：切张后旧请求不回写新素材）
  const [src, setSrc] = useState<string | null>(null);
  const [entered, setEntered] = useState(false);
  // §7.5 致命错误：主图与兜底都失败时显示「当前素材暂时无法显示」，重试需重新获取 URL/高清图
  const [mediaFatal, setMediaFatal] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  // 视频源 + 代理状态（§8.3：原文件失败 → 按需生成 H.264/AAC MP4）
  const [videoSrc, setVideoSrc] = useState<string | null>(() => convertFileSrc(initial.filePath));
  const [proxyError, setProxyError] = useState<string | null>(null);
  const [proxying, setProxying] = useState(false);
  const proxyAttempted = useRef(false);

  // 详情开关：左属性栏显隐（§2.3 工具栏「详情开关」）
  const [detailsOpen, setDetailsOpen] = useState(true);
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

  // 切张/重试：重置视图（MediaViewport 内部按 assetId 重置）+ 加载高清（失败退原图）
  useEffect(() => {
    setSrc(null);
    setMediaFatal(false);
    let cancelled = false;
    getThumbnailUrl(current.id, "hd", 1920)
      .then((u) => !cancelled && setSrc(u))
      .catch(() => !cancelled && setSrc(toFileUrl(current.filePath)));
    return () => {
      cancelled = true;
    };
  }, [current.id, current.filePath, reloadNonce]);

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

  // 切张：重置视频源与代理尝试标记（§8.1 播放决策顺序：原文件优先，失败再走代理）
  useEffect(() => {
    proxyAttempted.current = false;
    setProxyError(null);
    setProxying(false);
    setVideoSrc(convertFileSrc(current.filePath));
  }, [current.id, current.filePath]);

  // §8.1：原文件播放失败 → 按需生成兼容代理；代理失败给出可解释原因与操作建议
  const handleVideoError = useCallback(async () => {
    if (proxyAttempted.current) return;
    proxyAttempted.current = true;
    const id = current.id;
    setProxying(true);
    setProxyError(null);
    try {
      const proxy = await ensureVideoProxy(id, "h264_mp4");
      if (proxy.status === "ready" && proxy.path) {
        setVideoSrc(toProxyFileUrl(proxy.path));
        setProxyError(null);
      } else {
        setProxyError(proxy.error ?? "视频编码不兼容，且没有可用的兼容代理");
      }
    } catch (e) {
      setProxyError(e instanceof Error ? e.message : String(e));
    } finally {
      setProxying(false);
    }
  }, [current.id]);

  const handleCancelProxy = () => {
    void cancelVideoProxy(current.id, "h264_mp4").catch(() => undefined);
    setProxyError("已取消生成代理");
  };

  // 键盘：←→ 过片，Esc 退出。§4.3 忽略输入框/下拉/文本域/contentEditable/播放器根节点与子节点/模态层
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target) || isInsidePlayer(e.target)) return;
      if (assignOpen) return; // 模态打开时页面切片不响应
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") goto(index - 1);
      else if (e.key === "ArrowRight") goto(index + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, goto, onClose, assignOpen]);

  const isVideo = isVideoAsset(current);

  return (
    <div
      className={clsx(
        "h-full min-h-0 transition-all duration-200 ease-out",
        entered ? "opacity-100" : "opacity-0",
      )}
    >
      <ViewerShell
        toolbar={
          <ViewerToolbar
            fileName={current.fileName}
            position={index >= 0 ? `${index + 1} / ${total}` : ""}
            detailsOpen={detailsOpen}
            onToggleDetails={() => setDetailsOpen((v) => !v)}
            onClose={onClose}
          />
        }
        sidebar={
          detailsOpen ? (
            <ViewerInfoSidebar
              asset={current}
              tags={current.tags}
              onRemoveTag={(tagId) => void removeTag(tagId)}
              onAddTag={openAssign}
              onRefreshed={(a) => patchLocal([a.id], a)}
            />
          ) : null
        }
        stage={
          isVideo ? (
            <MediaViewport assetId={current.id} isVideo fileName={current.fileName} video={
              <VideoPlayer
                src={videoSrc ?? ""}
                fileName={current.fileName}
                className="h-full w-full"
                proxying={proxying}
                proxyError={proxyError}
                onCancelProxy={handleCancelProxy}
                onRetryProxy={() => {
                  proxyAttempted.current = false;
                  setProxyError(null);
                  void handleVideoError();
                }}
                onError={() => void handleVideoError()}
              />
            } />
          ) : (
            <MediaViewport
              assetId={current.id}
              isVideo={false}
              imageSrc={src}
              imageFallbackUrl={toFileUrl(current.filePath)}
              fileName={current.fileName}
              onImageError={() => {
                // §7.5：高清图失败→回落原文件；兜底也失败→致命错误（重新加载需重新获取 URL/高清图）
                if (src && src === toFileUrl(current.filePath)) {
                  setMediaFatal(true);
                } else {
                  setSrc(toFileUrl(current.filePath));
                }
              }}
              fatal={mediaFatal}
              onRetryCurrent={() => setReloadNonce((n) => n + 1)}
              onBackToLibrary={onClose}
            />
          )
        }
        filmstrip={
          <ViewerFilmstrip
            items={items}
            currentId={currentId}
            onJump={goto}
            onPrev={() => goto(index - 1)}
            onNext={() => goto(index + 1)}
          />
        }
      />

      <TagAssignDialog open={assignOpen} onClose={closeAssign} />
    </div>
  );
}