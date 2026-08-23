/** 导出弹窗：选项卡[本地文件 | 网盘分享链接]，网盘 M2 置灰（PRD 5.2/5.3） */
import { useEffect, useState } from "react";
import clsx from "clsx";
import { open as pickDir } from "@tauri-apps/plugin-dialog";
import Modal from "@/components/common/Modal";
import Button from "@/components/common/Button";
import ProgressBar from "@/components/common/ProgressBar";
import { exportLocalFiles, exportCsvManifest, onExportProgress, type ExportLayout } from "@/api/export";
import { useTauriEvent } from "@/hooks/hooks";
import { useSelectionStore } from "@/stores/selectionStore";

interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
  /** 初始模式（M3-04：「移动到目录」入口传 move，默认 copy） */
  initialMode?: "copy" | "move";
}

export default function ExportDialog({ open, onClose, initialMode = "copy" }: ExportDialogProps) {
  const selected = useSelectionStore((s) => s.selected);
  const [tab, setTab] = useState<"local" | "cloud">("local");
  const [destDir, setDestDir] = useState("");
  const [mode, setMode] = useState<"copy" | "move">("copy");
  /** R-26：子目录组织 + CSV 清单 */
  const [layout, setLayout] = useState<ExportLayout>("flat");
  const [withCsv, setWithCsv] = useState(false);
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
      setMode(initialMode);
      setLayout("flat");
      setWithCsv(false);
      setProgress(null);
      setResult(null);
      setError(null);
    }
  }, [open, initialMode]);

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
      const task = await exportLocalFiles(Array.from(selected), destDir, mode, layout);
      const verb = mode === "move" ? "移动" : "导出";
      let msg =
        task.status === "done"
          ? `${verb}完成：${task.done}/${task.total} 个文件 → ${destDir}${task.warning ? `（${task.warning}）` : ""}`
          : `${verb}${task.status === "cancelled" ? "已取消" : "失败"}${task.error ? `：${task.error}` : ""}`;
      // R-26：CSV 清单（仅在文件导出成功时生成）
      if (withCsv && task.status === "done") {
        try {
          const csvPath = await exportCsvManifest(Array.from(selected), destDir);
          msg += `；清单：${csvPath}`;
        } catch (ce) {
          msg += `；清单生成失败：${ce instanceof Error ? ce.message : String(ce)}`;
        }
      }
      setResult(msg);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title={`${mode === "move" ? "移动" : "导出"} ${selected.size} 项素材`} onClose={busy ? () => undefined : onClose}
      footer={
        tab === "local" ? (
          <>
            <Button onClick={onClose} disabled={busy}>关闭</Button>
            <Button variant="primary" disabled={!destDir || busy || selected.size === 0} onClick={run}>
              {busy ? (mode === "move" ? "移动中…" : "导出中…") : mode === "move" ? "开始移动" : "开始导出"}
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
          {/* R-26：目录组织 + CSV 清单 */}
          <div className="flex items-center gap-3 text-sm">
            <span className="shrink-0 text-xs text-[var(--color-text-secondary)]">目录组织</span>
            <select
              value={layout}
              onChange={(e) => setLayout(e.target.value as ExportLayout)}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm outline-none"
            >
              <option value="flat">平铺（不分目录）</option>
              <option value="by_tag">按标签分目录</option>
              <option value="by_date">按拍摄月份分目录</option>
            </select>
            <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-[var(--color-text-secondary)]">
              <input type="checkbox" checked={withCsv} onChange={(e) => setWithCsv(e.target.checked)} />
              附 CSV 清单（文件名/标签/EXIF）
            </label>
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
