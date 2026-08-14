/** 删除确认弹窗：双策略选择，「删除文件」需二次确认（PRD 5.4-4） */
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import Modal from "@/components/common/Modal";
import Button from "@/components/common/Button";
import { deleteAssets, type DeleteStrategy } from "@/api/assets";
import { useLibraryStore } from "@/stores/libraryStore";
import { useSelectionStore } from "@/stores/selectionStore";

interface DeleteDialogProps {
  open: boolean;
  onClose: () => void;
}

export default function DeleteDialog({ open, onClose }: DeleteDialogProps) {
  const { selected, clear } = useSelectionStore(useShallow((s) => ({ selected: s.selected, clear: s.clear })));
  const removeLocal = useLibraryStore((s) => s.removeLocal);
  const [strategy, setStrategy] = useState<DeleteStrategy>("remove_from_library");
  const [confirmingFile, setConfirmingFile] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ids = Array.from(selected);

  const close = () => {
    setStrategy("remove_from_library");
    setConfirmingFile(false);
    setError(null);
    onClose();
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await deleteAssets(ids, strategy);
      // B03：磁盘删除失败的不从库删——只移除成功的，提示失败数
      const successIds = ids.filter((id) => !result.failedFiles.includes(id));
      if (successIds.length > 0) removeLocal(successIds);
      clear();
      if (result.failedFiles.length > 0) {
        // 部分失败：提示用户，不关闭弹窗（失败的 id 仍在库中，可关闭占用后重试）
        setError(
          `${result.failedFiles.length} 个文件删除失败（可能被占用），已从库中移除其余 ${result.deleted} 项`,
        );
      } else {
        close();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onConfirm = () => {
    if (strategy === "delete_file" && !confirmingFile) {
      setConfirmingFile(true);
      return;
    }
    void run();
  };

  return (
    <Modal open={open} title={`删除 ${ids.length} 项素材`} onClose={close}
      footer={
        <>
          <Button onClick={close}>取消</Button>
          <Button variant="danger" disabled={busy || ids.length === 0} onClick={onConfirm}>
            {confirmingFile ? "确认永久删除" : busy ? "删除中…" : "确认删除"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="radio"
            name="del-strategy"
            checked={strategy === "remove_from_library"}
            onChange={() => {
              setStrategy("remove_from_library");
              setConfirmingFile(false);
            }}
            className="mt-1"
          />
          <span>
            <span className="block text-[var(--color-text)]">仅移出库（保留原文件）</span>
            <span className="block text-xs text-[var(--color-text-secondary)]">从素材库移除记录与缩略图，磁盘文件不动</span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="radio"
            name="del-strategy"
            checked={strategy === "delete_file"}
            onChange={() => setStrategy("delete_file")}
            className="mt-1"
          />
          <span>
            <span className="block text-[var(--color-danger)]">删除文件（不可恢复）</span>
            <span className="block text-xs text-[var(--color-text-secondary)]">连同磁盘上的原始文件一起删除</span>
          </span>
        </label>
        {confirmingFile && (
          <p className="rounded bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-danger)]">
            二次确认：即将永久删除 {ids.length} 个原始文件，此操作不可恢复！
          </p>
        )}
        {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}
      </div>
    </Modal>
  );
}
