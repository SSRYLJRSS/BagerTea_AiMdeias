/** 重复素材检测弹窗（M3-02 R-20 + W5d）：hash 精确分组 / 感知相似分组两种模式。
 *  精确组高亮最早入库项，其余可勾选批量处理；删除走现有双策略
 *  （借鉴 digiKam 去重向导「保留策略建议 + 逐组确认」形态）。
 *  W5d（§W5d）：相似图模式走 dedup_scan_similar（dHash 汉明 ≤ 8 + 可选排除同源 RAW+JPG）。
 */
import { useEffect, useState } from "react";
import Modal from "@/components/common/Modal";
import Button from "@/components/common/Button";
import Thumbnail from "@/components/library/Thumbnail";
import { deleteAssets, scanDuplicates, scanDuplicatesSimilar, type DeleteStrategy } from "@/api/assets";
import { useLibraryStore } from "@/stores/libraryStore";
import type { DupGroup } from "@/types/asset";

interface DupDialogProps {
  open: boolean;
  onClose: () => void;
}

type ScanMode = "exact" | "similar";

export default function DupDialog({ open, onClose }: DupDialogProps) {
  const removeLocal = useLibraryStore((s) => s.removeLocal);
  const [mode, setMode] = useState<ScanMode>("exact");
  const [excludeKinship, setExcludeKinship] = useState(true);
  const [groups, setGroups] = useState<DupGroup[]>([]);
  const [scanning, setScanning] = useState(false);
  /** 勾选待处理的素材 id（默认每组除最早项外全选） */
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [strategy, setStrategy] = useState<DeleteStrategy>("remove_from_library");
  const [confirmingFile, setConfirmingFile] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setScanning(true);
    setError(null);
    const run = mode === "exact"
      ? scanDuplicates()
      : scanDuplicatesSimilar(8, excludeKinship);
    run
      .then((gs) => {
        setGroups(gs);
        // 默认勾选每组非最早项（保留策略建议）
        const next = new Set<number>();
        for (const g of gs) for (const a of g.assets.slice(1)) next.add(a.id);
        setChecked(next);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setScanning(false));
  }, [open, mode, excludeKinship]);

  const close = () => {
    setStrategy("remove_from_library");
    setConfirmingFile(false);
    setError(null);
    onClose();
  };

  const toggle = (id: number) =>
    setChecked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const run = async () => {
    const ids = Array.from(checked);
    if (ids.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await deleteAssets(ids, strategy);
      const successIds = new Set(ids.filter((id) => !result.failedFiles.includes(id)));
      if (successIds.size > 0) removeLocal(Array.from(successIds));
      // 局部刷新分组：剔除已删项，剩不足 2 项的组不再是重复
      setGroups((gs) =>
        gs
          .map((g) => ({ ...g, assets: g.assets.filter((a) => !successIds.has(a.id)) }))
          .filter((g) => g.assets.length > 1),
      );
      setChecked((s) => new Set(Array.from(s).filter((id) => !successIds.has(id))));
      if (result.failedFiles.length > 0) {
        setError(`${result.failedFiles.length} 个文件删除失败（可能被占用），已处理其余 ${result.deleted} 项`);
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

  const similar = mode === "similar";

  return (
    <Modal open={open} title="查找重复素材" onClose={close} wide
      footer={
        <>
          {error && <p className="mr-auto self-center text-xs text-[var(--color-danger)]">{error}</p>}
          <Button onClick={close}>关闭</Button>
          <Button variant="danger" disabled={busy || checked.size === 0} onClick={onConfirm}>
            {confirmingFile ? "确认永久删除" : busy ? "处理中…" : `处理选中 ${checked.size} 项`}
          </Button>
        </>
      }
    >
      {/* W5d：精确重复 / 相似图 模式切换 */}
      <div className="mb-3 flex items-center gap-2">
        <div className="grid grid-cols-2 rounded-lg bg-[var(--color-surface)] p-0.5" aria-label="扫描模式">
          <button
            type="button"
            onClick={() => setMode("exact")}
            data-active={!similar}
            className="rounded-md px-3 py-1.5 text-xs text-[var(--color-text-secondary)] transition-colors data-[active=true]:bg-[var(--color-surface-raised)] data-[active=true]:font-semibold data-[active=true]:text-[var(--color-text)] data-[active=true]:shadow-sm"
          >
            精确重复
          </button>
          <button
            type="button"
            onClick={() => setMode("similar")}
            data-active={similar}
            className="rounded-md px-3 py-1.5 text-xs text-[var(--color-text-secondary)] transition-colors data-[active=true]:bg-[var(--color-surface-raised)] data-[active=true]:font-semibold data-[active=true]:text-[var(--color-text)] data-[active=true]:shadow-sm"
          >
            相似图
          </button>
        </div>
        {similar && (
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--color-text-secondary)]">
            <input
              type="checkbox"
              checked={excludeKinship}
              onChange={(e) => setExcludeKinship(e.target.checked)}
              className="accent-[var(--color-accent)]"
            />
            排除同源 RAW+JPG
          </label>
        )}
      </div>

      {scanning && <p className="py-6 text-center text-sm text-[var(--color-text-secondary)]">扫描中…</p>}

      {!scanning && groups.length === 0 && (
        <p className="py-6 text-center text-sm text-[var(--color-text-secondary)]">
          {similar ? "未发现相似素材" : "未发现重复素材"}
        </p>
      )}

      {!scanning && groups.length > 0 && (
        <div className="flex flex-col gap-4">
          <p className="text-xs text-[var(--color-text-secondary)]">
            {similar
              ? `共 ${groups.length} 组相似（按画面感知相似匹配）。每组高亮项为最早入库、建议保留，其余可勾选处理。`
              : `共 ${groups.length} 组重复（按文件内容 hash 精确匹配）。每组高亮项为最早入库、建议保留，其余可勾选处理。`}
          </p>

          <div className="flex max-h-[46vh] flex-col gap-3 overflow-y-auto">
            {groups.map((g) => (
              <div key={g.hash} className="rounded-lg border border-[var(--color-border)] p-2">
                <div className="flex flex-wrap gap-2">
                  {g.assets.map((a, i) => {
                    const keep = i === 0;
                    return (
                      <div key={a.id} className="flex w-[120px] flex-col gap-1">
                        <button
                          onClick={() => !keep && toggle(a.id)}
                          className={
                            "relative h-[88px] overflow-hidden rounded-md border-2 transition-colors " +
                            (keep
                              ? "border-[var(--color-accent)]"
                              : checked.has(a.id)
                                ? "border-[var(--color-danger)]"
                                : "border-transparent")
                          }
                          title={a.filePath}
                        >
                          <Thumbnail assetId={a.id} placeholderPath={a.placeholderPath} alt={a.fileName} size={512} fit="cover" />
                          {keep && (
                            <span className="absolute top-1 left-1 rounded bg-[var(--color-accent)] px-1 text-[10px] text-[var(--color-accent-text)]">
                              建议保留
                            </span>
                          )}
                          {!keep && (
                            <input
                              type="checkbox"
                              readOnly
                              checked={checked.has(a.id)}
                              className="absolute top-1 right-1"
                            />
                          )}
                        </button>
                        <span className="truncate text-[10px] text-[var(--color-text-secondary)]" title={a.fileName}>
                          {a.fileName}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* 删除双策略（复用 DeleteDialog 交互约定） */}
          <div className="flex flex-col gap-2 border-t border-[var(--color-border)] pt-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="radio"
                name="dup-strategy"
                checked={strategy === "remove_from_library"}
                onChange={() => {
                  setStrategy("remove_from_library");
                  setConfirmingFile(false);
                }}
              />
              <span className="text-[var(--color-text)]">仅移出库（保留原文件）</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="radio"
                name="dup-strategy"
                checked={strategy === "delete_file"}
                onChange={() => setStrategy("delete_file")}
              />
              <span className="text-[var(--color-danger)]">删除文件（不可恢复）</span>
            </label>
            {confirmingFile && (
              <p className="rounded bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-danger)]">
                二次确认：即将永久删除 {checked.size} 个原始文件，此操作不可恢复！
              </p>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
