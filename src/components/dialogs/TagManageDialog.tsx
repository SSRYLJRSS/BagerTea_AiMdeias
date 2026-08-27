/** 标签管理弹窗（M3-01 R-19）：全量标签树 + 每节点「重命名/合并到…/移动到…/删除」
 *  借鉴 Eagle 标签合并交互（选目标标签吸收）；首期不做拖拽，菜单操作即可。
 *  删除不可逆：有关联素材时走 DeleteDialog 式二次确认。
 */
import { useCallback, useEffect, useState } from "react";
import Modal from "@/components/common/Modal";
import Button from "@/components/common/Button";
import { deactivateTag, listTagGovernance, mergeTags, updateTag } from "@/api/tags";
import { useTagStore } from "@/stores/tagStore";
import type { Tag, TagFacetGovernance, TagNode } from "@/types/tag";

interface TagManageDialogProps {
  open: boolean;
  onClose: () => void;
}

type RowAction = { kind: "merge" | "move" | "deactivate"; id: number } | null;

/** 管理视图全展开，不受侧栏折叠状态影响 */
function flattenAll(tree: TagNode[], depth = 0): { tag: Tag; depth: number; node: TagNode }[] {
  const out: { tag: Tag; depth: number; node: TagNode }[] = [];
  for (const node of tree) {
    out.push({ tag: node.tag, depth, node });
    out.push(...flattenAll(node.children, depth + 1));
  }
  return out;
}

/** 节点自身+后代 id 集合（防环选项过滤用） */
function collectSubtree(node: TagNode, acc: Set<number>): Set<number> {
  acc.add(node.tag.id);
  for (const c of node.children) collectSubtree(c, acc);
  return acc;
}

export default function TagManageDialog({ open, onClose }: TagManageDialogProps) {
  const tree = useTagStore((s) => s.tree);
  const refresh = useTagStore((s) => s.refresh);
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null);
  const [action, setAction] = useState<RowAction>(null);
  const [targetId, setTargetId] = useState<number | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [governance, setGovernance] = useState<TagFacetGovernance[]>([]);
  // A-3：加载失败显示局部错误和重试（不阻塞打开弹窗本身）
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    void refresh();
    try {
      setGovernance(await listTagGovernance());
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [refresh]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const rows = flattenAll(tree);

  const reset = () => {
    setEditing(null);
    setAction(null);
    setTargetId(null);
    setConfirmDel(false);
    setError(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await Promise.all([refresh(), listTagGovernance().then(setGovernance)]);
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doRename = () => {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) {
      setError("标签名不能为空");
      return;
    }
    void run(() => updateTag(editing.id, name));
  };

  const doMerge = () => {
    if (!action || targetId == null) return;
    void run(() => mergeTags(action.id, targetId));
  };

  const doMove = () => {
    if (!action) return;
    void run(() => updateTag(action.id, undefined, targetId));
  };

  const doDelete = () => {
    if (!action) return;
    const tag = rows.find((r) => r.tag.id === action.id)?.tag;
    // 有关联素材时二次确认（DeleteDialog 模式）
    if (tag && tag.totalCount > 0 && !confirmDel) {
      setConfirmDel(true);
      return;
    }
    void run(() => deactivateTag(action.id));
  };

  /** 合并/移动目标选项：排除自身子树（防环，后端也兜底校验） */
  const optionsFor = (id: number) => {
    const self = rows.find((r) => r.tag.id === id)?.node;
    const excluded = self ? collectSubtree(self, new Set<number>()) : new Set<number>();
    return rows.filter((r) => !excluded.has(r.tag.id));
  };

  return (
    <Modal open={open} title="标签管理" onClose={close} wide
      footer={
        <>
          {error && <p className="mr-auto self-center text-xs text-[var(--color-danger)]">{error}</p>}
          <Button onClick={close}>关闭</Button>
        </>
      }
    >
      {governance.length > 0 && (
        <div className="mb-3 grid grid-cols-2 gap-1.5 border-b border-[var(--color-border)] pb-3 sm:grid-cols-3">
          {governance.map((g) => (
            <div key={g.facetKey} className="rounded border border-[var(--color-border)] px-2 py-1.5 text-[11px]">
              <div className="truncate font-medium text-[var(--color-text)]">{g.facetKey}</div>
              <div className="mt-0.5 text-[var(--color-text-secondary)]">
                {g.activeTagCount} 个有效标签 · {g.linkedAssetCount} 个素材
              </div>
              {g.pendingAiItemCount > 0 && (
                <div className="text-[var(--color-accent)]">{g.pendingAiItemCount} 个 AI 候选待审</div>
              )}
            </div>
          ))}
        </div>
      )}
      {loadError && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-[var(--color-danger)] px-3 py-2 text-xs">
          <span className="flex-1 text-[var(--color-danger)]">加载失败：{loadError}</span>
          <Button variant="ghost" onClick={() => void load()}>重试</Button>
        </div>
      )}
      <div className="max-h-[60vh] overflow-y-auto">
        {rows.length === 0 && (
          <p className="py-4 text-center text-xs text-[var(--color-text-secondary)]">暂无标签</p>
        )}
        {rows.map(({ tag, depth }) => (
          <div key={tag.id} className="border-b border-[var(--color-border)]/50 last:border-b-0">
            {/* 常规行：名称 + 计数 + 操作按钮 */}
            {editing?.id !== tag.id && action?.id !== tag.id && (
              <div className="flex items-center gap-1 px-2 py-1.5" style={{ paddingLeft: 8 + depth * 18 }}>
                <span className="flex-1 truncate text-sm text-[var(--color-text)]">
                  {tag.name}
                  {tag.isPreset && <span className="ml-1 text-[10px] text-[var(--color-text-secondary)]">预置</span>}
                </span>
                <span className="text-xs text-[var(--color-text-secondary)]">{tag.totalCount}</span>
                {tag.isSystem ? (
                  <span className="text-[10px] text-[var(--color-text-secondary)]">系统分面</span>
                ) : (
                  <>
                    <RowBtn label="重命名" onClick={() => { reset(); setEditing({ id: tag.id, name: tag.name }); }} />
                    <RowBtn label="合并到…" onClick={() => { reset(); setAction({ kind: "merge", id: tag.id }); }} />
                    <RowBtn label="移动到…" onClick={() => { reset(); setAction({ kind: "move", id: tag.id }); }} />
                    <RowBtn label="停用" danger onClick={() => { reset(); setAction({ kind: "deactivate", id: tag.id }); }} />
                  </>
                )}
              </div>
            )}

            {/* 重命名行 */}
            {editing?.id === tag.id && (
              <div className="flex items-center gap-2 px-2 py-1.5" style={{ paddingLeft: 8 + depth * 18 }}>
                <input
                  autoFocus
                  value={editing.name}
                  onChange={(e) => setEditing({ id: tag.id, name: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && doRename()}
                  className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm text-[var(--color-text)] outline-none"
                />
                <Button variant="primary" disabled={busy} onClick={doRename}>{busy ? "保存中…" : "保存"}</Button>
                <Button disabled={busy} onClick={reset}>取消</Button>
              </div>
            )}

            {/* 合并 / 移动：选目标标签 */}
            {action && action.id === tag.id && (action.kind === "merge" || action.kind === "move") && (
              <div className="flex items-center gap-2 px-2 py-1.5" style={{ paddingLeft: 8 + depth * 18 }}>
                <span className="shrink-0 text-sm text-[var(--color-text)]">{tag.name}</span>
                <span className="shrink-0 text-xs text-[var(--color-text-secondary)]">
                  {action.kind === "merge" ? "合并到" : "移动到"}
                </span>
                <select
                  value={targetId ?? ""}
                  onChange={(e) => setTargetId(e.target.value === "" ? null : Number(e.target.value))}
                  className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm text-[var(--color-text)] outline-none"
                >
                  {action.kind === "move" && <option value="">顶级</option>}
                  {action.kind === "merge" && <option value="" disabled>选择目标标签…</option>}
                  {optionsFor(tag.id).map((r) => (
                    <option key={r.tag.id} value={r.tag.id}>
                      {"　".repeat(r.depth)}{r.tag.name}（{r.tag.totalCount}）
                    </option>
                  ))}
                </select>
                <Button
                  variant={action.kind === "merge" ? "danger" : "primary"}
                  disabled={busy || (action.kind === "merge" && targetId == null)}
                  onClick={action.kind === "merge" ? doMerge : doMove}
                >
                  {busy ? "处理中…" : action.kind === "merge" ? "确认合并" : "确认移动"}
                </Button>
                <Button disabled={busy} onClick={reset}>取消</Button>
              </div>
            )}

            {/* 删除确认 */}
            {action && action.id === tag.id && action.kind === "deactivate" && (
              <div className="flex items-center gap-2 px-2 py-1.5" style={{ paddingLeft: 8 + depth * 18 }}>
                <span className="flex-1 text-sm">
                  <span className="text-[var(--color-text)]">停用「{tag.name}」</span>
                  {tag.totalCount > 0 && (
                    <span className="ml-1 text-xs text-[var(--color-danger)]">
                      将从搜索和新分配中隐藏，但保留历史关联
                    </span>
                  )}
                </span>
                {confirmDel && (
                  <span className="rounded bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-danger)]">
                    子标签也会一并停用
                  </span>
                )}
                <Button variant="danger" disabled={busy} onClick={doDelete}>
                  {busy ? "停用中…" : confirmDel ? "确认停用" : "确认停用"}
                </Button>
                <Button disabled={busy} onClick={reset}>取消</Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}

function RowBtn({ label, danger, onClick }: { label: string; danger?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={
        danger
          ? "shrink-0 rounded px-1.5 py-0.5 text-xs text-[var(--color-danger)] transition-colors hover:bg-[var(--color-surface)]"
          : "shrink-0 rounded px-1.5 py-0.5 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
      }
    >
      {label}
    </button>
  );
}
