/** 挂标签弹窗：勾选现有标签 / 新建标签，批量挂到选中素材 */
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import Modal from "@/components/common/Modal";
import Button from "@/components/common/Button";
import TagChip from "@/components/library/TagChip";
import { assignTags, createTag } from "@/api/tags";
import { useTagStore } from "@/stores/tagStore";
import { useLibraryStore } from "@/stores/libraryStore";
import { useSelectionStore } from "@/stores/selectionStore";
import type { TagNode } from "@/types/tag";

interface TagAssignDialogProps {
  open: boolean;
  onClose: () => void;
}

export default function TagAssignDialog({ open, onClose }: TagAssignDialogProps) {
  const { selected, clear } = useSelectionStore(useShallow((s) => ({ selected: s.selected, clear: s.clear })));
  const { tree, refresh } = useTagStore(useShallow((s) => ({ tree: s.tree, refresh: s.refresh })));
  const refreshLibrary = useLibraryStore((s) => s.refresh);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPicked(new Set());
      setNewName("");
      setError(null);
      if (tree.length === 0) void refresh();
    }
  }, [open, tree.length, refresh]);

  const allTags = useMemo(() => flatten(tree), [tree]);

  const toggle = (id: number) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const createAndPick = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const tag = await createTag(name, null);
      await refresh();
      setPicked((s) => new Set(s).add(tag.id));
      setNewName("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (picked.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      await assignTags(Array.from(selected), Array.from(picked));
      clear();
      await Promise.all([refresh(), refreshLibrary()]);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title={`为 ${selected.size} 项素材挂标签`} onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={picked.size === 0 || busy} onClick={apply}>
            {busy ? "处理中…" : `挂上 ${picked.size} 个标签`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex max-h-48 flex-wrap content-start gap-1.5 overflow-y-auto">
          {allTags.map((t) => (
            <TagChip key={t.id} label={t.name} active={picked.has(t.id)} onClick={() => toggle(t.id)} />
          ))}
          {allTags.length === 0 && (
            <span className="text-xs text-[var(--color-text-secondary)]">还没有标签，先在下方新建一个</span>
          )}
        </div>
        <div className="flex gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void createAndPick()}
            placeholder="新建标签…"
            className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          />
          <Button onClick={createAndPick} disabled={!newName.trim() || busy}>
            新建
          </Button>
        </div>
        {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}
      </div>
    </Modal>
  );
}

function flatten(tree: TagNode[]): { id: number; name: string }[] {
  return tree.flatMap((n) => [{ id: n.tag.id, name: n.tag.name }, ...flatten(n.children)]);
}
