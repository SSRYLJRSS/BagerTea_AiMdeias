import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { useShallow } from "zustand/react/shallow";
import { useLibraryStore } from "@/stores/libraryStore";
import { useMetadataStore } from "@/stores/metadataStore";
import { bucketToFilter } from "./metadataConvert";
import type { MetadataFilter } from "@/types/asset";

/** 从当前 filter 反推某个分面当前选中的「原始展示值」集合（用于高亮/计数/换绑）。
 *  通过 bucketToFilter 的逆映射判断某 value 是否已生效。为减少复杂度：
 *  离散分面按 key 的 in/eq 值判断；范围分面按是否已存在等价条件判断。
 */
function isValueActive(filters: MetadataFilter[], key: string, value: string): boolean {
  const relevant = filters.filter((f) => f.key === key);
  const filter = bucketToFilter(key, value);
  if (!filter) return false;
  // 离散分面：in 命中 values 或 eq 命中 value
  if (relevant.some((f) => f.op === "in" && (f.values ?? []).some((item) => String(item) === value))) return true;
  if (relevant.some((f) => f.op === "eq" && String(f.value) === value)) return true;
  // 范围分面：已有同 key 条件即视为该 bucket 生效（单 bucket 语义）
  if (filter.op !== "eq") return relevant.length > 0;
  return false;
}

/** 把某个分面当前选中的原始值集合转成 op 化 MetadataFilter 数组。
 *  离散分面合并为一条 in；范围分面每条自成条件（面板按 key 单 bucket 交互）。 */
function selectedToFilters(selected: Map<string, string[]>): MetadataFilter[] {
  const out: MetadataFilter[] = [];
  for (const [key, values] of selected) {
    if (values.length === 0) continue;
    const first = bucketToFilter(key, values[0]);
    if (!first) continue;
    const isDiscreteEq = first.op === "eq";
    // 数值型离散分面（iso/aperture/focal）：后端已支持 `in` 且接受数字字符串（P0-2），
    // 把多个选中值合并为一条 `in`，值为数字，避免字符串传给数值编译器导致整次查询失败。
    if (isDiscreteEq && ["iso", "aperture", "focal"].includes(first.key)) {
      const nums = values.map((v) => Number(v)).filter((n) => Number.isFinite(n));
      if (nums.length > 0) out.push({ key: first.key, op: "in", values: nums });
    } else if (isDiscreteEq) {
      // 字符串离散分面：合并为一条 `in`（值保持字符串）。
      out.push({ key: first.key, op: "in", values: [...values] });
    } else {
      // 范围分面：只取最后一个 bucket（面板按 key 单 bucket 交互）
      out.push(first);
    }
  }
  return out;
}

export default function MetadataPanel() {
  const { facets, loading, loaded, refresh } = useMetadataStore(
    useShallow((s) => ({ facets: s.facets, loading: s.loading, loaded: s.loaded, refresh: s.refresh })),
  );
  const { filter, setFilter } = useLibraryStore(
    useShallow((s) => ({ filter: s.filter, setFilter: s.setFilter })),
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!loaded && !loading) void refresh();
  }, [loaded, loading, refresh]);

  // 由当前 filter 的 metadataFilters 重建各分面选中值
  const [selected, setSelected] = useState<Map<string, string[]>>(() => new Map());
  useEffect(() => {
    const next = new Map<string, string[]>();
    for (const facet of facets) {
      const activeValues = facet.items
        .map((item) => item.value)
        .filter((v) => isValueActive(filter.metadataFilters ?? [], facet.key, v));
      if (activeValues.length > 0) next.set(facet.key, activeValues);
    }
    setSelected(next);
  }, [filter.metadataFilters, facets]);

  const toggle = (key: string, value: string, isRange: boolean) => {
    const cur = selected.get(key) ?? [];
    const active = cur.includes(value);
    let values: string[];
    if (isRange) {
      // 范围分面单 bucket：点选替换，再点取消
      values = active ? [] : [value];
    } else {
      values = active ? cur.filter((v) => v !== value) : [...cur, value];
    }
    const next = new Map(selected);
    if (values.length > 0) next.set(key, values);
    else next.delete(key);
    setSelected(next);
    setFilter({ metadataFilters: selectedToFilters(next), untaggedOnly: false, trashOnly: false });
  };

  const visibleFacets = useMemo(() => facets.filter((facet) => facet.items.length > 0), [facets]);
  const allCollapsed = visibleFacets.length > 0 && visibleFacets.every((facet) => collapsed.has(facet.key));
  const toggleGroup = (key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const toggleAll = () => {
    setCollapsed(allCollapsed ? new Set() : new Set(visibleFacets.map((facet) => facet.key)));
  };

  if (loading && facets.length === 0) {
    return <p className="px-3 py-3 text-xs text-[var(--color-text-secondary)]">正在读取文件属性…</p>;
  }

  if (visibleFacets.length === 0) {
    return (
      <p className="px-3 py-3 text-xs leading-5 text-[var(--color-text-secondary)]">
        暂无可筛选的文件属性。导入带 EXIF 信息的图片或视频后会自动显示。
      </p>
    );
  }

  return (
    <div className="flex flex-col pb-3 text-sm">
      <div className="flex items-center justify-end gap-1 px-2 pt-1">
        <button
          type="button"
          onClick={toggleAll}
          className="px-1.5 py-1 text-[10px] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
        >
          {allCollapsed ? "全部展开" : "全部收起"}
        </button>
      </div>
      {visibleFacets.map((facet) => {
        const isRange = ["file_size", "duration", "resolution", "taken_month"].includes(facet.key);
        return (
        <section key={facet.key} className="pt-2">
          <button
            type="button"
            onClick={() => toggleGroup(facet.key)}
            className="flex w-full items-center justify-between px-2 pb-1 text-left"
            aria-expanded={!collapsed.has(facet.key)}
          >
            <span>
              <span className="block text-[11px] font-semibold text-[var(--color-text)]">{facet.displayName}</span>
              <span className="mt-0.5 block text-[10px] text-[var(--color-text-tertiary)]">{facet.description}</span>
            </span>
            <span className="ml-2 flex items-center gap-1.5 text-xs text-[var(--color-text-tertiary)]">
              {(selected.get(facet.key) ?? []).length ? (
                <span className="rounded-full bg-[var(--color-status-soft)] px-1.5 py-0.5 text-[9px] text-[var(--color-status)]">
                  {(selected.get(facet.key) ?? []).length}
                </span>
              ) : null}
              {collapsed.has(facet.key) ? "▸" : "▾"}
            </span>
          </button>
          {!collapsed.has(facet.key) && <div className="flex flex-col gap-0.5">
            {facet.items.map((item) => {
              const active = (selected.get(facet.key) ?? []).includes(item.value);
              return (
                <button
                  key={item.value}
                  onClick={() => toggle(facet.key, item.value, isRange)}
                  data-active={active}
                  title={item.label}
                  className={clsx(
                    "ui-nav-item flex min-h-8 items-center justify-between px-2 py-1.5 text-left text-[var(--color-text-secondary)] transition-colors",
                    "hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]",
                  )}
                >
                  <span className="truncate">{item.label}</span>
                  <span className="ml-2 min-w-6 shrink-0 text-right text-xs text-[var(--color-text-tertiary)]">
                    {item.count}
                  </span>
                </button>
              );
            })}
          </div>}
        </section>
        );
      })}
    </div>
  );
}
