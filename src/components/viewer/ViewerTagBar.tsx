/** FB2-04 ViewerTagBar：查看器舞台下方、把塌陷空白变成标签展示区（§10）。
 *  按分面分组显示（buildWorkbenchFacets），复用 TagChip；内边距 px-4 py-2；
 *  可折叠（h-24 ↔ h-8，折叠动画只切固定高度类 + transition-[height]，不触发 auto 高度级联）。
 *  图片与视频共用同一组件（不做视频分支，天然一致）。
 *  仅承载展示 + 删除；添加仍走容器注入（避免在查看器内再造一个完整打标工作台）。 */
import { memo, useMemo, useState } from "react";
import TagChip from "@/components/library/TagChip";
import { useTagStore, buildWorkbenchFacets } from "@/stores/tagStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { Tag } from "@/types/tag";

interface ViewerTagBarProps {
  assetId: number;
  tags: Tag[];
  onRemoveTag: (tagId: number) => void;
  onAddTag: () => void;
}

export default memo(function ViewerTagBar({ tags, onRemoveTag, onAddTag }: ViewerTagBarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const settings = useSettingsStore((s) => s.settings);
  // 分面唯一事实源 = tag_facets（tagStore.facets），aiFacetConfigs 只覆盖显隐/显示名
  const tagFacets = useTagStore((s) => s.facets);
  const facets = useMemo(
    () => buildWorkbenchFacets(tagFacets, settings?.aiFacetConfigs ?? []),
    [tagFacets, settings?.aiFacetConfigs],
  );
  // 分组：固定顺序按 facets 出现顺序；未知 facetKey 归「其他」
  const groups = useMemo(() => {
    const byKey = new Map<string, Tag[]>();
    for (const f of facets) byKey.set(f.key, []);
    const other: Tag[] = [];
    for (const t of tags) {
      const list = byKey.get(t.facetKey);
      if (list) list.push(t);
      else other.push(t);
    }
    const out: { key: string; name: string; items: Tag[] }[] = facets
      .filter((f) => (byKey.get(f.key) ?? []).length > 0)
      .map((f) => ({ key: f.key, name: f.displayName, items: byKey.get(f.key)! }));
    if (other.length) out.push({ key: "other", name: "其他", items: other });
    return out;
  }, [tags, facets]);

  return (
    <div
      className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-bg)]"
      style={{ height: collapsed ? 32 : 96 }}
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-controls="viewer-tagbar-body"
        onClick={() => setCollapsed((v) => !v)}
        className="flex h-8 w-full items-center gap-2 px-4 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text)]"
      >
        <span className="font-medium">标签</span>
        <span className="text-[var(--color-text-tertiary)]">{tags.length} 项</span>
        <span className="ml-auto select-none">{collapsed ? "展开 ▾" : "收起 ▴"}</span>
      </button>
      {!collapsed && (
        <div id="viewer-tagbar-body" className="h-16 overflow-y-auto px-4">
          {groups.length === 0 && (
            <div className="flex items-center gap-2 text-xs text-[var(--color-text-tertiary)]">未打标</div>
          )}
          {groups.map((g) => (
            <div key={g.key} className="flex gap-2 py-0.5">
              <span className="w-20 shrink-0 text-[11px] text-[var(--color-text-secondary)]">{g.name}</span>
              <div className="flex flex-wrap items-center gap-1">
                {g.items.map((t) => (
                  <TagChip key={t.id} label={t.name} onRemove={() => onRemoveTag(t.id)} />
                ))}
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={onAddTag}
            className="mt-1 rounded border border-dashed border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
          >
            + 添加标签
          </button>
        </div>
      )}
    </div>
  );
});