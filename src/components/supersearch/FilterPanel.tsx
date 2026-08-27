/** 超级搜索筛选面板（P2.6）：类型/未打标/文件属性分面/排序。
 *  标签分面选择依赖 tagId，由标签树/后续接入；这里先输出可用的元数据比较条件。 */
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useMetadataStore } from "@/stores/metadataStore";
import { useSuperSearchStore } from "@/stores/superSearchStore";
import { bucketToFilter } from "@/components/library/metadataConvert";
import type { ResolvedSearchQuery, AssetType, MetadataFilter } from "@/types/asset";

const TYPE_TABS: { key: AssetType; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "image", label: "图片" },
  { key: "video", label: "视频" },
];

const SORTS: { value: ResolvedSearchQuery["sortBy"]; label: string }[] = [
  { value: "created_at", label: "入库时间" },
  { value: "taken_at", label: "拍摄时间" },
  { value: "modified_at", label: "修改时间" },
  { value: "name", label: "文件名" },
  { value: "size", label: "文件大小" },
  { value: "resolution", label: "分辨率" },
];

function sameMeta(a: MetadataFilter, b: MetadataFilter): boolean {
  return (
    a.key === b.key &&
    a.op === b.op &&
    JSON.stringify({ v: a.value, vs: a.values ?? [], mn: a.min, mx: a.max }) ===
      JSON.stringify({ v: b.value, vs: b.values ?? [], mn: b.min, mx: b.max })
  );
}

export default function FilterPanel() {
  const { query, setQuery } = useSuperSearchStore(
    useShallow((s) => ({ query: s.query, setQuery: s.setQuery })),
  );
  const facets = useMetadataStore((s) => s.facets);
  const facetsLoaded = useMetadataStore((s) => s.loaded);
  const refreshFacets = useMetadataStore((s) => s.refresh);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    if (!facetsLoaded) void refreshFacets();
  }, [facetsLoaded, refreshFacets]);

  const toggleType = (t: AssetType) => setQuery({ assetType: t, untaggedOnly: false });

  const visibleFacets = useMemo(() => facets.filter((f) => f.items.length > 0), [facets]);
  const toggleGroup = (key: string) =>
    setCollapsed((set) => {
      const next = new Set(set);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /** 切换一个分面值对应的比较条件（追加或移除） */
  const toggleFacetValue = (key: string, value: string) => {
    const filter = bucketToFilter(key, value);
    if (!filter) return;
    const current = query.metadataFilters ?? [];
    const exists = current.some((m) => sameMeta(m, filter));
    const next = exists ? current.filter((m) => !sameMeta(m, filter)) : [...current, filter];
    setQuery({ metadataFilters: next });
  };

  return (
    <div className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-[var(--color-border)] bg-[var(--color-bg)]">
      <Section title="类型">
        <div className="flex flex-col gap-0.5 px-2">
          {TYPE_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => toggleType(t.key)}
              data-active={!query.untaggedOnly && query.assetType === t.key}
              className="ui-nav-item px-2.5 py-2 text-left text-sm text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
            >
              {t.label}
            </button>
          ))}
          <button
            onClick={() => setQuery({ untaggedOnly: true })}
            data-active={query.untaggedOnly}
            className="ui-nav-item px-2.5 py-2 text-left text-sm text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
          >
            未打标
          </button>
        </div>
      </Section>

      <Section title="排序">
        <div className="flex items-center gap-1 px-2">
          <select
            value={query.sortBy}
            onChange={(e) => setQuery({ sortBy: e.target.value as ResolvedSearchQuery["sortBy"] })}
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-xs text-[var(--color-text-secondary)] outline-none"
          >
            {SORTS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <button
            onClick={() => setQuery({ sortDir: query.sortDir === "desc" ? "asc" : "desc" })}
            className="rounded px-1.5 py-0.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            title={query.sortDir === "desc" ? "降序" : "升序"}
          >
            {query.sortDir === "desc" ? "↓" : "↑"}
          </button>
        </div>
      </Section>

      <Section title="文件属性">
        {visibleFacets.map((facet) => (
          <div key={facet.key} className="pt-1">
            <button
              onClick={() => toggleGroup(facet.key)}
              className="flex w-full items-center justify-between px-2 pb-1 text-left"
              aria-expanded={!collapsed.has(facet.key)}
            >
              <span className="text-[11px] font-semibold text-[var(--color-text)]">{facet.displayName}</span>
              <span className="text-xs text-[var(--color-text-tertiary)]">{collapsed.has(facet.key) ? "▸" : "▾"}</span>
            </button>
            {!collapsed.has(facet.key) && (
              <div className="flex flex-col gap-0.5 px-2">
                {facet.items.map((item) => {
                  const filter = bucketToFilter(facet.key, item.value);
                  const active = !!filter && (query.metadataFilters ?? []).some((m) => sameMeta(m, filter));
                  return (
                    <button
                      key={item.value}
                      onClick={() => toggleFacetValue(facet.key, item.value)}
                      data-active={active}
                      className="ui-nav-item flex min-h-7 items-center justify-between px-2 py-1 text-left text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
                    >
                      <span className="truncate">{item.label}</span>
                      <span className="ml-2 text-[var(--color-text-tertiary)]">{item.count}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ))}
        {visibleFacets.length === 0 && (
          <p className="px-2 py-1 text-[10px] text-[var(--color-text-tertiary)]">导入含 EXIF 的素材后出现</p>
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-[var(--color-border)] py-2">
      <h3 className="ui-section-title px-3 pb-1.5">{title}</h3>
      {children}
    </section>
  );
}
