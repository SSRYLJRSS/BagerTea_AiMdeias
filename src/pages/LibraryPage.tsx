/** 素材库页：顶栏筛选 + 左侧任务栏 + 虚拟网格 + 上下文操作条 + 弹窗组（PRD 5.2/5.3）。
 *  §7.2：Viewer 与库页互斥——preview 非空时整体返回 ViewerPage，
 *  GridToolbar/SideBar/AssetGrid 完全卸载；关闭后恢复筛选/滚动/选中上下文（store 持有）。 */
import { useEffect, useState } from "react";
import GridToolbar from "@/components/library/GridToolbar";
import SideBar from "@/components/library/SideBar";
import AssetGrid from "@/components/library/AssetGrid";
import DeleteDialog from "@/components/dialogs/DeleteDialog";
import DupDialog from "@/components/dialogs/DupDialog";
import ExportDialog from "@/components/dialogs/ExportDialog";
import TagAssignDialog from "@/components/dialogs/TagAssignDialog";
import ViewerPage from "@/components/library/ViewerPage";
import { useLibraryStore } from "@/stores/libraryStore";
import { useSelectionStore } from "@/stores/selectionStore";
import { useAiStore } from "@/stores/aiStore";
import type { Asset } from "@/types/asset";

type DialogKey = "delete" | "purge" | "export" | "tags" | "dedup" | null;

export default function LibraryPage() {
  const refresh = useLibraryStore((s) => s.refresh);
  const error = useLibraryStore((s) => s.error);
  const selected = useSelectionStore((s) => s.selected);
  const [dialog, setDialog] = useState<DialogKey>(null);
  /** 导出/移动弹窗初始模式（M3-04：「移动到目录」入口） */
  const [exportMode, setExportMode] = useState<"copy" | "move">("copy");
  const [preview, setPreview] = useState<Asset | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** §7.3 方案 A：打开/关闭 Viewer 同步全局 viewerOpen（App 据此隐藏 BottomBar） */
  const openViewer = (asset: Asset) => {
    setPreview(asset);
    useLibraryStore.getState().setViewerOpen(true);
  };
  const closeViewer = () => {
    setPreview(null);
    useLibraryStore.getState().setViewerOpen(false);
  };

  // §7.2 互斥：Viewer 打开时整体替换库页内容（库页工具栏/侧栏/网格全部卸载）
  if (preview) {
    return <ViewerPage asset={preview} onClose={closeViewer} />;
  }

  // 顶栏与右键菜单共用同一组批量动作（v2.8）
  // v2.10：打标（AI/手动）都跳转打标页，模式随选择带过去
  const actions = {
    onAiTag: () => {
      useAiStore.getState().setPendingAssets(Array.from(selected), "auto");
      window.dispatchEvent(new CustomEvent("app:navigate", { detail: "ai" }));
    },
    onAssignTags: () => {
      useAiStore.getState().setPendingAssets(Array.from(selected), "manual");
      window.dispatchEvent(new CustomEvent("app:navigate", { detail: "ai" }));
    },
    onExport: () => {
      setExportMode("copy");
      setDialog("export");
    },
    onMove: () => {
      setExportMode("move");
      setDialog("export");
    },
    onDelete: () => setDialog("delete"),
    onDedup: () => setDialog("dedup"),
    // R-22：回收站「彻底删除」（锁定 delete_file 策略）
    onPurge: () => setDialog("purge"),
  };

  return (
    <div className="relative flex h-full flex-col">
      <GridToolbar {...actions} />
      <div className="flex min-h-0 flex-1">
        <SideBar />
        <AssetGrid onPreview={openViewer} {...actions} />
      </div>

      {error && (
        <div className="absolute right-3 bottom-3 rounded-md bg-[var(--color-danger)] px-3 py-2 text-xs text-white shadow-lg">
          {error}
        </div>
      )}

      <DeleteDialog open={dialog === "delete"} onClose={() => setDialog(null)} />
      <DeleteDialog open={dialog === "purge"} purgeOnly onClose={() => setDialog(null)} />
      <DupDialog open={dialog === "dedup"} onClose={() => setDialog(null)} />
      <ExportDialog open={dialog === "export" && selected.size > 0} initialMode={exportMode} onClose={() => setDialog(null)} />
      <TagAssignDialog open={dialog === "tags"} onClose={() => setDialog(null)} />
    </div>
  );
}