/** 标签树形导航：可折叠、父标签显示合计数、点击连带筛选子标签（PRD 5.4-3） */
import { useEffect } from "react";
import clsx from "clsx";
import { useShallow } from "zustand/react/shallow";
import { flattenVisible, useTagStore } from "@/stores/tagStore";
import { useLibraryStore } from "@/stores/libraryStore";

export default function TagTree() {
  const { tree, expanded, refresh, toggleExpand } = useTagStore(
    useShallow((s) => ({ tree: s.tree, expanded: s.expanded, refresh: s.refresh, toggleExpand: s.toggleExpand })),
  );
  const { filter, setFilter } = useLibraryStore(useShallow((s) => ({ filter: s.filter, setFilter: s.setFilter })));

  useEffect(() => {
    if (tree.length === 0) void refresh();
  }, [tree.length, refresh]);

  const rows = flattenVisible(tree, expanded);

  return (
    <div className="flex flex-col py-1 text-sm">
      {/* 「未打标」归标签区（v2.7 修订）；点标签行筛选，再点已激活标签取消 */}
      <TreeRow
        label="未打标"
        active={filter.untaggedOnly}
        onClick={() => setFilter({ tagId: null, untaggedOnly: true })}
      />

      {rows.map(({ node, depth }) => {
        const hasChildren = node.children.length > 0;
        const isOpen = expanded.has(node.tag.id);
        const active = filter.tagId === node.tag.id && !filter.untaggedOnly;
        return (
          <div key={node.tag.id} className="flex items-center" style={{ paddingLeft: depth * 14 }}>
            <button
              aria-label={isOpen ? "折叠" : "展开"}
              onClick={() => hasChildren && toggleExpand(node.tag.id)}
              className={clsx(
                "w-4 shrink-0 text-[10px] text-[var(--color-text-secondary)]",
                !hasChildren && "invisible",
              )}
            >
              {isOpen ? "▾" : "▸"}
            </button>
            <TreeRow
              label={node.tag.name}
              count={node.tag.totalCount}
              active={active}
              onClick={() => setFilter({ tagId: active ? null : node.tag.id, untaggedOnly: false })}
            />
          </div>
        );
      })}

      {tree.length === 0 && (
        <p className="px-3 py-2 text-xs text-[var(--color-text-secondary)]">暂无标签</p>
      )}
    </div>
  );
}

function TreeRow({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "flex flex-1 items-center justify-between rounded px-2 py-1 text-left transition-colors",
        active
          ? "bg-[var(--color-surface)] font-medium text-[var(--color-text)]"
          : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]",
      )}
    >
      <span className="truncate">{label}</span>
      {count != null && <span className="ml-1 shrink-0 text-xs opacity-60">{count}</span>}
    </button>
  );
}
