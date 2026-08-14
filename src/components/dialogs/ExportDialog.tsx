/** 导出弹窗：选项卡[本地文件 | 网盘分享链接]，网盘 M2 置灰（PRD 5.2/5.3） */
import { useEffect, useState } from "react";
import clsx from "clsx";
import { open as pickDir } from "@tauri-apps/plugin-dialog";
import Modal from "@/components/common/Modal";
import Button from "@/components/common/Button";
import ProgressBar from "@/components/common/ProgressBar";
import { exportLocalFiles, onExportProgress } from "@/api/export";
import { useTauriEvent } from "@/hooks/hooks";
import { useSelectionStore } from "@/stores/selectionStore";

interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
}

export default function ExportDialog({ open, onClose }: ExportDialogProps) {
  const selected = useSelectionStore((s) => s.selected);
  const [tab, setTab] = useState<"local" | "cloud">("local");
  const [destDir, setDestDir] = useState("");
  const [mode, setMode] = useState<"copy" | "move">("copy");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useTauriEvent(
    () =>
      onExportProgress((p) => {
        setProgress({ done: p.done, total: p.total });
      }),
    [],
  );

  useEffect(() => {
    if (open) {
      setProgress(null);
      setResult(null);
      setError(null);
    }
  }, [open]);

  const chooseDir = async () => {
    const dir = await pickDir({ directory: true });
    if (typeof dir === "string") setDestDir(dir);
  };

  const run = async () => {
    if (!destDir) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const task = await exportLocalFiles(Array.from(selected), destDir, mode);
      setResult(
        task.status === "done"
          ? `导出完成：${task.done}/${task.total} 个文件 → ${destDir}`
          : `导出${task.status === "cancelled" ? "已取消" : "失败"}${task.error ? `：${task.error}` : ""}`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title={`导出 ${selected.size} 项素材`} onClose={busy ? () => undefined : onClose}
      footer={
        tab === "local" ? (
          <>
            <Button onClick={onClose} disabled={busy}>关闭</Button>
            <Button variant="primary" disabled={!destDir || busy || selected.size === 0} onClick={run}>
              {busy ? "导出中…" : "开始导出"}
            </Button>
          </>
        ) : undefined
      }
    >
      {/* 选项卡 */}
      <div className="mb-4 flex gap-1 border-b border-[var(--color-border)]">
        {(
          [
            { key: "local", label: "本地文件" },
            { key: "cloud", label: "网盘分享链接（M2）" },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={clsx(
              "-mb-px border-b-2 px-3 py-1.5 text-sm transition-colors",
              tab === t.key
                ? "border-[var(--color-accent)] text-[var(--color-text)]"
                : "border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text)]",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "local" ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={destDir}
              placeholder="选择目标目录…"
              className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm outline-none"
            />
            <Button onClick={chooseDir}>浏览…</Button>
          </div>
          <div className="flex gap-4 text-sm">
            {(
              [
                { key: "copy", label: "复制到目标目录" },
                { key: "move", label: "移动到目标目录" },
              ] as const
            ).map((m) => (
              <label key={m.key} className="flex cursor-pointer items-center gap-1.5">
                <input type="radio" name="export-mode" checked={mode === m.key} onChange={() => setMode(m.key)} />
                {m.label}
              </label>
            ))}
          </div>
          {progress && (
            <div className="flex flex-col gap-1">
              <ProgressBar value={progress.total ? progress.done / progress.total : 0} />
              <span className="text-xs text-[var(--color-text-secondary)]">
                {progress.done}/{progress.total}
              </span>
            </div>
          )}
          {result && <p className="text-xs text-[var(--color-text)]">{result}</p>}
          {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}
        </div>
      ) : (
        <div className="py-6 text-center text-sm text-[var(--color-text-secondary)]">
          百度 / 夸克网盘分享链接将于二期（M2）开放，
          <br />
          届时可在此上传选中素材并生成分享链接。
        </div>
      )}
    </Modal>
  );
}
