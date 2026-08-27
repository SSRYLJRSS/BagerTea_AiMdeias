import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useLibraryStore } from "@/stores/libraryStore";
import { useMetadataStore } from "@/stores/metadataStore";
import { useTagStore } from "@/stores/tagStore";
import type { MetadataFilter } from "@/types/asset";
import type { TagNode } from "@/types/tag";

function collectTagNames(nodes: TagNode[], target = new Map<number, string>()): Map<number, string> {
  for (const node of nodes) {
    target.set(node.tag.id, node.tag.name);
    collectTagNames(node.children, target);
  }
  return target;
}

const LABELS: Record<string, string> = {
  file_ext: "格式",
  mime_type: "MIME",
  width: "宽",
  height: "高",
  resolution: "分辨率",
  aspect_ratio: "宽高比",
  file_size: "文件大小",
  duration_ms: "视频时长",
  taken_at: "拍摄时间",
  created_at: "入库时间",
  modified_at: "修改时间",
  camera: "相机",
  lens: "镜头",
  iso: "ISO",
  aperture: "光圈",
  shutter: "快门",
  focal: "焦距",
  video_codec: "视频编码",
  audio_codec: "音频编码",
  folder: "文件夹",
};

const OP_TEXT: Record<string, string> = {
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  eq: "=",
  contains: "含",
  between: "…",
  in: "∈",
};

function fmtValue(v: string | number): string {
  return String(v);
}

function fmt(op: string, v?: string | number): string {
  return v === undefined ? "" : `${OP_TEXT[op] ?? op} ${fmtValue(v)}`;
}

/** 元数据条件 → 可读芯片标签 */
function metaLabel(f: MetadataFilter): string {
  const name = LABELS[f.key] ?? f.key;
  if (f.op === "between") {
    return `${name} ${fmtValue(f.min ?? "")}–${fmtValue(f.max ?? "")}`;
  }
  if (f.op === "in") {
    return `${name} ∈ ${(f.values ?? []).map(fmtValue).join("|")}`;
  }
  return `${name} ${fmt(f.op, f.value)}`;
}

/** 移除一条元数据条件 */
function removeMeta(filter: ReturnType<typeof useLibraryStore.getState>["filter"], target: MetadataFilter): Partial<ReturnType<typeof useLibraryStore.getState>["filter"]> {
  // 按 key + op + 值精确匹配移除一条；同一 key 可能多条（不同 op）
  const rest = (filter.metadataFilters ?? []).filter((m) => !sameMeta(m, target));
  return { metadataFilters: rest };
}

function sameMeta(a: MetadataFilter, b: MetadataFilter): boolean {
  if (a.key !== b.key || a.op !== b.op) return false;
  return (
    JSON.stringify({ v: a.value, vs: a.values ?? [], mn: a.min, mx: a.max }) ===
    JSON.stringify({ v: b.value, vs: b.values ?? [], mn: b.min, mx: b.max })
  );
}

export default function SelectedFilterTags() {
  const { filter, setFilter } = useLibraryStore(
    useShallow((s) => ({ filter: s.filter, setFilter: s.setFilter })),
  );
  const tree = useTagStore((s) => s.tree);
  const metadataFacets = useMetadataStore((s) => s.facets);
  const tagNames = useMemo(() => collectTagNames(tree), [tree]);
  const metadataLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const facet of metadataFacets) {
      for (const item of facet.items) labels.set(`${facet.key}:${item.value}`, item.label);
    }
    return labels;
  }, [metadataFacets]);

  const removeSmartTag = (facetKey: string, tagId: number) => {
    const current = filter.facetFilters ?? [];
    const group = current.find((item) => item.facetKey === facetKey);
    const values = (group?.tagIds ?? []).filter((id) => id !== tagId);
    const rest = current.filter((item) => item.facetKey !== facetKey);
    setFilter({ facetFilters: values.length > 0 && group ? [...rest, { ...group, tagIds: values }] : rest });
  };

  const metadataLabelOf = (m: MetadataFilter): string => {
    // 若 value 命中分面展示 label 则用之
    if (m.op === "eq" && m.key && m.value !== undefined) {
      const hit = metadataLabels.get(`${m.key}:${m.value}`);
      if (hit) return `${LABELS[m.key] ?? m.key}：${hit}`;
    }
    return metaLabel(m);
  };

  const chips = [
    ...(filter.untaggedOnly
      ? [{ key: "untagged", label: "未打标", onRemove: () => setFilter({ untaggedOnly: false }) }]
      : []),
    ...(filter.facetFilters ?? []).flatMap((facet) => facet.tagIds.map((tagId) => ({
      key: `tag:${tagId}`,
      label: tagNames.get(tagId) ?? `标签 #${tagId}`,
      onRemove: () => removeSmartTag(facet.facetKey, tagId),
    }))),
    ...(filter.excludeTagIds ?? []).map((tagId) => ({
      key: `exclude:${tagId}`,
      label: `排除：${tagNames.get(tagId) ?? `标签 #${tagId}`}`,
      onRemove: () => setFilter({ excludeTagIds: (filter.excludeTagIds ?? []).filter((id) => id !== tagId) }),
    })),
    ...(filter.metadataFilters ?? []).map((m) => ({
      key: `metadata:${m.key}:${m.op}:${m.value ?? (m.min ?? "")}:${m.max ?? ""}`,
      label: metadataLabelOf(m),
      onRemove: () => setFilter(removeMeta(filter, m)),
    })),
  ];

  if (chips.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1" aria-label="已选标签">
      <span className="shrink-0 text-[11px] text-[var(--color-text-tertiary)]">已选</span>
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] pl-2.5 pr-1 text-xs text-[var(--color-text)]"
        >
          {chip.label}
          <button
            type="button"
            onClick={chip.onRemove}
            className="flex size-5 items-center justify-center rounded-full text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
            aria-label={`取消筛选 ${chip.label}`}
            title={`取消 ${chip.label}`}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
