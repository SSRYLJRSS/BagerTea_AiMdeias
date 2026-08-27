/** 标签树形导航：可折叠、父标签显示合计数、点击连带筛选子标签（PRD 5.4-3） */
import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import clsx from "clsx";
import { useShallow } from "zustand/react/shallow";
import { flattenVisible, useTagStore } from "@/stores/tagStore";
import { useLibraryStore } from "@/stores/libraryStore";

interface TagTreeProps {
  onManage?: () => void;
}

export default function TagTree({ onManage }: TagTreeProps) {
  const { tree, facets, expanded, refresh, toggleExpand } = useTagStore(
    useShallow((s) => ({ tree: s.tree, facets: s.facets, expanded: s.expanded, refresh: s.refresh, toggleExpand: s.toggleExpand })),
  );
  const { filter, setFilter } = useLibraryStore(useShallow((s) => ({ filter: s.filter, setFilter: s.setFilter })));

  useEffect(() => {
    if (tree.length === 0) void refresh();
  }, [tree.length, refresh]);

  const groups = (facets.length > 0
    ? facets.map((facet) => ({ facet, rows: flattenVisible(tree.filter((n) => n.tag.facetKey === facet.key), expanded) }))
    : [{ facet: null, rows: flattenVisible(tree, expanded) }])
    .filter(({ rows }) => rows.length > 0);
  const currentFilters = filter.facetFilters ?? [];
  const excludedIds = filter.excludeTagIds ?? [];
  const [menu, setMenu] = useState<{ tagId: number; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  const toggleExcluded = (tagId: number) => {
    const excluded = excludedIds.includes(tagId);
    setFilter({
      excludeTagIds: excluded ? excludedIds.filter((id) => id !== tagId) : [...excludedIds, tagId],
      untaggedOnly: false,
      trashOnly: false,
    });
    setMenu(null);
  };

  return (
    <div className="flex flex-col py-1 text-sm">
      {/* 「未打标」归标签区（v2.7 修订）；点标签行筛选，再点已激活标签取消 */}
      <TreeRow
        label="未打标"
        active={filter.untaggedOnly}
        onClick={() => setFilter({ tagId: null, facetFilters: [], excludeTagIds: [], untaggedOnly: true, trashOnly: false })}
      />

      {groups.map(({ facet, rows }) => (
        <div key={facet?.key ?? "legacy"}>
          {facet && (
            <div className="px-2 pt-3 pb-1 text-[10px] font-semibold tracking-wide text-[var(--color-text-tertiary)]">
              {facet.displayName}
            </div>
          )}
          {rows.map(({ node, depth }) => {
        const hasChildren = node.children.length > 0;
        const isOpen = expanded.has(node.tag.id);
        const active = currentFilters.some((f) => f.tagIds.includes(node.tag.id)) && !filter.untaggedOnly;
        const excluded = excludedIds.includes(node.tag.id);
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
              excluded={excluded}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({
                  tagId: node.tag.id,
                  x: Math.min(event.clientX, window.innerWidth - 150),
                  y: Math.min(event.clientY, window.innerHeight - 90),
                });
              }}
              onClick={() => {
                const existing = currentFilters.find((f) => f.facetKey === node.tag.facetKey);
                const ids = existing?.tagIds ?? [];
                const nextIds = active ? ids.filter((id) => id !== node.tag.id) : [...ids, node.tag.id];
                const rest = currentFilters.filter((f) => f.facetKey !== node.tag.facetKey);
                const facetFilters = nextIds.length > 0
                  ? [...rest, {
                      facetKey: node.tag.facetKey,
                      tagIds: nextIds,
                      mode: existing?.mode ?? ("any" as const),
                      includeDescendants: existing?.includeDescendants ?? true,
                    }]
                  : rest;
                setFilter({ tagId: null, facetFilters, untaggedOnly: false, trashOnly: false });
              }}
            />
          </div>
        );
          })}
        </div>
      ))}

      {tree.length === 0 && (
        <p className="px-3 py-2 text-xs text-[var(--color-text-secondary)]">暂无标签</p>
      )}

      {menu && (
        <div
          className="fixed z-50 min-w-32 border border-[var(--color-border)] bg-[var(--color-bg)] py-1 text-xs shadow-lg"
          style={{ left: menu.x, top: menu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            className="block w-full px-3 py-1.5 text-left text-[var(--color-text)] hover:bg-[var(--color-surface)]"
            onClick={() => toggleExcluded(menu.tagId)}
          >
            {excludedIds.includes(menu.tagId) ? "取消排除" : "排除此标签"}
          </button>
          {onManage && (
            <button
              className="block w-full px-3 py-1.5 text-left text-[var(--color-text)] hover:bg-[var(--color-surface)]"
              onClick={() => {
                setMenu(null);
                onManage();
              }}
            >
              管理标签
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function TreeRow({
  label,
  count,
  active,
  excluded = false,
  onClick,
  onContextMenu,
}: {
  label: string;
  count?: number;
  active: boolean;
  excluded?: boolean;
  onClick: () => void;
  onContextMenu?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={clsx(
        "ui-nav-item flex min-h-8 flex-1 items-center justify-between px-2 py-1.5 text-left text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]",
      )}
      data-active={active}
    >
      <span className={clsx("truncate", excluded && "line-through opacity-60")}>{label}</span>
      {count != null && <span className="ml-2 min-w-6 shrink-0 text-right text-xs text-[var(--color-text-tertiary)]">{count}</span>}
    </button>
  );
}
