/** 素材库页：顶栏筛选 + 左侧任务栏 + 虚拟网格 + 上下文操作条 + 弹窗组（PRD 5.2/5.3） */
import { useEffect, useState } from "react";
import GridToolbar from "@/components/library/GridToolbar";
import SideBar from "@/components/library/SideBar";
import AssetGrid from "@/components/library/AssetGrid";
import DeleteDialog from "@/components/dialogs/DeleteDialog";
import ExportDialog from "@/components/dialogs/ExportDialog";
import TagAssignDialog from "@/components/dialogs/TagAssignDialog";
import ViewerPage from "@/components/library/ViewerPage";
import { useLibraryStore } from "@/stores/libraryStore";
import { useSelectionStore } from "@/stores/selectionStore";
import { useAiStore } from "@/stores/aiStore";
import type { Asset } from "@/types/asset";

type DialogKey = "delete" | "export" | "tags" | null;

export default function LibraryPage() {
  const refresh = useLibraryStore((s) => s.refresh);
  const error = useLibraryStore((s) => s.error);
  const selected = useSelectionStore((s) => s.selected);
  const [dialog, setDialog] = useState<DialogKey>(null);
  const [preview, setPreview] = useState<Asset | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 顶栏与右键菜单共用同一组批量动作（v2.8）
  // v2.10：打标（AI/手动）都跳转打标页，模式随选择带过去
  const actions = {
    onAiTag: () => {
      useAiStore.getState().setPendingAssets(Array.from(selected), "cloud");
      window.dispatchEvent(new CustomEvent("app:navigate", { detail: "ai" }));
    },
    onAssignTags: () => {
      useAiStore.getState().setPendingAssets(Array.from(selected), "manual");
      window.dispatchEvent(new CustomEvent("app:navigate", { detail: "ai" }));
    },
    onExport: () => setDialog("export"),
    onDelete: () => setDialog("delete"),
  };

  return (
    <div className="relative flex h-full flex-col">
      <GridToolbar {...actions} />
      <div className="flex min-h-0 flex-1">
        <SideBar />
        <AssetGrid onPreview={setPreview} {...actions} />
      </div>

      {error && (
        <div className="absolute right-3 bottom-3 rounded-md bg-[var(--color-danger)] px-3 py-2 text-xs text-white shadow-lg">
          {error}
        </div>
      )}

      <DeleteDialog open={dialog === "delete"} onClose={() => setDialog(null)} />
      <ExportDialog open={dialog === "export" && selected.size > 0} onClose={() => setDialog(null)} />
      <TagAssignDialog open={dialog === "tags"} onClose={() => setDialog(null)} />
      {preview && <ViewerPage asset={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
