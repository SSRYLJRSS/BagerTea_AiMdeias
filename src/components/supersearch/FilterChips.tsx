/** 超级搜索条件芯片（P2.7 + §11.6）：可单独删除、可清除全部。AI 与手动条件用同一种芯片。
 *  §11.6（FB-05）：AI 解析后显示可读 chips——「主体：建筑 × 色彩：红色 × 关系：全部满足」；
 *  标签名取自后端 resolvedTags（含 tagId→名称/分面），未知退回「标签#id」；
 *  用户删除 chip 直接改 query（不重新调 AI）。 */
import { useShallow } from "zustand/react/shallow";
import { useSuperSearchStore } from "@/stores/superSearchStore";
import type { MetadataFilter } from "@/types/asset";

const LABELS: Record<string, string> = {
  file_ext: "格式", mime_type: "MIME", width: "宽", height: "高",
  resolution: "分辨率", aspect_ratio: "宽高比", file_size: "文件大小",
  duration_ms: "视频时长", taken_at: "拍摄时间", created_at: "入库时间",
  modified_at: "修改时间", camera: "相机", lens: "镜头", iso: "ISO",
  aperture: "光圈", shutter: "快门", focal: "焦距", video_codec: "视频编码",
  audio_codec: "音频编码", folder: "文件夹",
};

/** 分面 key → 显示名（与 tagStore BASE_FACET_DEFAULTS 对齐；未知回退 key） */
const FACET_NAMES: Record<string, string> = {
  subject: "主体/对象", scene: "场景/地点", purpose: "用途", style: "风格/氛围",
  color: "色彩", composition: "构图/视角", lighting: "光线/时间", people: "人物属性",
  technical: "可用性/技术特征", custom: "自定义", location: "地点", event: "事件",
};

function facetName(key: string): string {
  return FACET_NAMES[key] ?? key;
}

const OP_TEXT: Record<string, string> = { gt: ">", gte: "≥", lt: "<", lte: "≤", eq: "=", contains: "含", between: "", in: "∈" };

function fmtValue(v: string | number) { return String(v); }

function metaLabel(f: MetadataFilter): string {
  const name = LABELS[f.key] ?? f.key;
  if (f.op === "between") return `${name} ${fmtValue(f.min ?? "")}–${fmtValue(f.max ?? "")}`;
  if (f.op === "in") return `${name} ∈ ${(f.values ?? []).map(fmtValue).join("|")}`;
  if (f.op === "eq" && f.value !== undefined) return `${name} = ${fmtValue(f.value)}`;
  return `${name} ${OP_TEXT[f.op] ?? f.op} ${f.value !== undefined ? fmtValue(f.value) : ""}`;
}

export default function FilterChips() {
  const { query, resolvedTags, relation, setQuery, replaceQuery } = useSuperSearchStore(
    useShallow((s) => ({
      query: s.query,
      resolvedTags: s.resolvedTags,
      relation: s.relation,
      setQuery: s.setQuery,
      replaceQuery: s.replaceQuery,
    })),
  );

  type Chip = { key: string; label: string; onRemove: () => void };
  const chips: Chip[] = [];

  if (query.search) {
    chips.push({ key: "search", label: `关键词：${query.search}`, onRemove: () => setQuery({ search: "" }) });
  }
  if (query.assetType !== "all") {
    chips.push({
      key: "type", label: `类型：${query.assetType === "image" ? "图片" : "视频"}`,
      onRemove: () => setQuery({ assetType: "all" }),
    });
  }
  if (query.untaggedOnly) {
    chips.push({ key: "untagged", label: "未打标", onRemove: () => setQuery({ untaggedOnly: false }) });
  }
  // §11.6 可读标签：优先 AI resolvedTags（含名称/分面），未知退回「标签#id」
  const nameById = new Map<number, { facetKey: string; text: string }>();
  for (const rt of resolvedTags) nameById.set(rt.tagId, { facetKey: rt.facetKey, text: rt.text });
  for (const f of query.facetFilters) {
    for (const tid of f.tagIds) {
      const info = nameById.get(tid);
      const fname = facetName(f.facetKey);
      chips.push({
        key: `facet:${f.facetKey}:${tid}`,
        label: info ? `${fname}：${info.text}` : `${fname} · 标签#${tid}`,
        onRemove: () =>
          setQuery({
            facetFilters: query.facetFilters
              .map((g) => (g.facetKey === f.facetKey ? { ...g, tagIds: g.tagIds.filter((x) => x !== tid) } : g))
              .filter((g) => g.tagIds.length > 0 || g.facetKey !== f.facetKey),
          }),
      });
    }
  }
  for (const tid of query.excludeTagIds) {
    const info = nameById.get(tid);
    chips.push({
      key: `exclude:${tid}`,
      label: info ? `排除：${info.text}` : `排除：标签#${tid}`,
      onRemove: () => setQuery({ excludeTagIds: query.excludeTagIds.filter((x) => x !== tid) }),
    });
  }
  for (const m of query.metadataFilters) {
    chips.push({
      key: `meta:${m.key}:${m.op}:${m.value ?? m.min ?? ""}:${m.max ?? ""}`,
      label: metaLabel(m),
      onRemove: () => setQuery({ metadataFilters: query.metadataFilters.filter((x) => x !== m) }),
    });
  }
  if (query.sortBy !== "created_at" || query.sortDir !== "desc") {
    chips.push({
      key: "sort", label: `排序：${query.sortBy} ${query.sortDir}`,
      onRemove: () => setQuery({ sortBy: "created_at", sortDir: "desc" }),
    });
  }

  if (chips.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1" aria-label="筛选条件">
      <span className="shrink-0 text-[11px] text-[var(--color-text-tertiary)]">
        条件（{relation === "or" ? "任一" : "全部"}）
      </span>
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
            aria-label={`取消 ${chip.label}`}
            title={`取消 ${chip.label}`}
          >
            ×
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={() => void replaceQuery({ search: "", assetType: "all", untaggedOnly: false, facetFilters: [], excludeTagIds: [], missingFacetKeys: [], metadataFilters: [], sortBy: "created_at", sortDir: "desc" })}
        className="shrink-0 rounded-full px-2 py-1 text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
      >
        清除全部
      </button>
    </div>
  );
}