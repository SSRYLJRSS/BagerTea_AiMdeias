/** 挂标签弹窗：勾选现有标签 / 新建标签，批量挂到选中素材 */
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import Modal from "@/components/common/Modal";
import Button from "@/components/common/Button";
import TagChip from "@/components/library/TagChip";
import { assignTags, createCanonicalTag } from "@/api/tags";
import { useTagStore } from "@/stores/tagStore";
import { useLibraryStore } from "@/stores/libraryStore";
import { useSelectionStore } from "@/stores/selectionStore";
import type { Tag, TagNode } from "@/types/tag";

interface TagAssignDialogProps {
  open: boolean;
  onClose: () => void;
}

export default function TagAssignDialog({ open, onClose }: TagAssignDialogProps) {
  const { selected, clear } = useSelectionStore(useShallow((s) => ({ selected: s.selected, clear: s.clear })));
  const { tree, facets, refresh } = useTagStore(
    useShallow((s) => ({ tree: s.tree, facets: s.facets, refresh: s.refresh })),
  );
  const refreshLibrary = useLibraryStore((s) => s.refresh);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [newName, setNewName] = useState("");
  const [query, setQuery] = useState("");
  const [facetKey, setFacetKey] = useState("custom");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPicked(new Set());
      setNewName("");
      setQuery("");
      setError(null);
      if (tree.length === 0) void refresh();
    }
  }, [open, tree.length, refresh]);

  // W3-5：按分面折叠分组（与 W3-3b optgroup 同构）——标签多了以后平铺不可用。
  // 分组遍历后端 facets（自建分面自动成组）；系统标签不过滤（分面清单一处事实源）。
  const groupedTags = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = flatten(tree).filter((tag) => !tag.isSystem && (!q || tag.path.toLowerCase().includes(q) || tag.aliases.some((a) => a.toLowerCase().includes(q))));
    const groups = new Map<string, Tag[]>();
    for (const t of all) {
      const list = groups.get(t.facetKey) ?? [];
      list.push(t);
      groups.set(t.facetKey, list);
    }
    // 按后端 facets 的 sortOrder 排组；未知 facet（已删除分面残留）排最后
    const order = new Map(facets.map((f, i) => [f.key, i]));
    return [...groups.entries()].sort((a, b) => (order.get(a[0]) ?? 999) - (order.get(b[0]) ?? 999));
  }, [tree, query, facets]);

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
      const tag = await createCanonicalTag(name, facetKey, null);
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
        <div className="flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标签、路径或别名…"
            className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          />
          <select
            value={facetKey}
            onChange={(e) => setFacetKey(e.target.value)}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm outline-none"
          >
            {facets.map((facet) => <option key={facet.key} value={facet.key}>{facet.displayName}</option>)}
          </select>
        </div>
        <div className="flex max-h-64 flex-col gap-2 overflow-y-auto">
          {groupedTags.map(([facetKey, tags]) => {
            const facet = facets.find((f) => f.key === facetKey);
            return (
              <div key={facetKey}>
                <p className="mb-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
                  {facet?.displayName ?? facetKey}
                </p>
                <div className="flex flex-wrap content-start gap-1.5">
                  {tags.map((t) => (
                    <TagChip key={t.id} label={t.path || t.name} active={picked.has(t.id)} onClick={() => toggle(t.id)} />
                  ))}
                </div>
              </div>
            );
          })}
          {groupedTags.length === 0 && (
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

function flatten(tree: TagNode[]): Tag[] {
  return tree.flatMap((n) => [n.tag, ...flatten(n.children)]);
}
