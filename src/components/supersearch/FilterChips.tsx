/** 超级搜索条件芯片（FB5-05 §9.6.1）：expr 为唯一条件源。
 *  - chips 递归遍历 expr：AND 组显示「同时满足」，OR 根按组显示「任一组 N」，NOT 叶显示「排除：…」；
 *  - 每个 chip 保存稳定 expr path，删除只摘除该节点后 normalize（禁止走 setQuery 清空整棵 AI 树）；
 *  - 排序 chip 独立（setSort）；「清除全部」调用 clearConditions 同时清 expr 与兼容扁平筛选；
 *  - 无 expr 时（纯手动条件链路）退回扁平 query 渲染，仍可逐项删除。 */
import { useShallow } from "zustand/react/shallow";
import { useSuperSearchStore } from "@/stores/superSearchStore";
import { useTagStore } from "@/stores/tagStore";
import type { MetadataFilter } from "@/types/asset";
import {
  flattenExprForDisplay,
  type ExprChipModel,
} from "@/utils/queryExprUtils";

const LABELS: Record<string, string> = {
  file_ext: "格式", mime_type: "MIME", width: "宽", height: "高",
  resolution: "分辨率", aspect_ratio: "宽高比", file_size: "文件大小",
  duration_ms: "视频时长", taken_at: "拍摄时间", created_at: "入库时间",
  modified_at: "修改时间", camera: "相机", lens: "镜头", iso: "ISO",
  aperture: "光圈", shutter: "快门", focal: "焦距", video_codec: "视频编码",
  audio_codec: "音频编码", folder: "文件夹",
};

/** W3：分面显示名优先读 tagStore.facets（自建分面自动显示中文名）；
 *  FACET_NAMES 只是系统分面在 store 未加载时的兜底。 */
const FACET_NAMES: Record<string, string> = {
  subject: "主体/对象", scene: "场景/地点", purpose: "用途", style: "风格/氛围",
  color: "色彩", composition: "构图/视角", lighting: "光线/时间", people: "人物属性",
  technical: "可用性/技术特征", custom: "自定义",
};

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
  const { query, expr, resolvedTags, removeExprAtPath, setQuery, setSort, clearConditions } = useSuperSearchStore(
    useShallow((s) => ({
      query: s.query,
      expr: s.expr,
      resolvedTags: s.resolvedTags,
      removeExprAtPath: s.removeExprAtPath,
      setQuery: s.setQuery,
      setSort: s.setSort,
      clearConditions: s.clearConditions,
    })),
  );

  type Chip = { key: string; label: string; group?: string; onRemove: () => void };
  const chips: Chip[] = [];

  if (expr) {
    // §9.6.1：expr 是唯一条件源（AI 树 / 构建器树）
    const models: ExprChipModel[] = flattenExprForDisplay(expr, resolvedTags);
    for (const m of models) {
      chips.push({ key: m.key, label: m.label, group: m.group, onRemove: () => removeExprAtPath(m.path) });
    }
  } else {
    // 纯手动条件链路（无 expr）：扁平 query 渲染，仍逐项删除
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
    const nameById = new Map<number, { facetKey: string; text: string }>();
    for (const rt of resolvedTags) nameById.set(rt.tagId, { facetKey: rt.facetKey, text: rt.text });
    for (const f of query.facetFilters) {
      for (const tid of f.tagIds) {
        const info = nameById.get(tid);
        const fname = useTagStore.getState().facets.find((x) => x.key === f.facetKey)?.displayName ?? FACET_NAMES[f.facetKey] ?? f.facetKey;
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
  }

  // 排序 chip 不属于 expr：独立 setSort
  if (query.sortBy !== "created_at" || query.sortDir !== "desc") {
    chips.push({
      key: "sort", label: `排序：${query.sortBy} ${query.sortDir}`,
      onRemove: () => setSort("created_at", "desc"),
    });
  }

  if (chips.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1" aria-label="筛选条件">
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] pl-2.5 pr-1 text-xs text-[var(--color-text)]"
        >
          {chip.group && (
            <span className="text-[10px] text-[var(--color-text-tertiary)]">{chip.group}</span>
          )}
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
        onClick={() => void clearConditions()}
        className="shrink-0 rounded-full px-2 py-1 text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
      >
        清除全部
      </button>
    </div>
  );
}
