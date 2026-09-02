/** 飞书式条件公式构建器：一个条件组 + 多行字段/运算符/值编辑。
 *  FB5-05（§9.6.1）：遇到当前无法编辑的嵌套树（OR/嵌套 NOT）时——
 *  不得把 expr 转成空 rows 回写；显示「复杂条件（N 项）」只读摘要，
 *  新增手动条件时把新 leaf 与整棵现有 expr 以 AND 合并（不破坏内部 OR 分组）。
 *  FB5-05（§9.8）：已有非空 tagId 优先 tagStore options，找不到再从 resolvedTags 注入
 *  synthetic option，两边都找不到时显示「标签 #id」，绝不退回「选择标签」。 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTagStore } from "@/stores/tagStore";
import { useSuperSearchStore } from "@/stores/superSearchStore";
import type { AssetType, MetadataFilter, MetadataFilterKey, MetadataOp } from "@/types/asset";
import type { LeafCond, QueryExpr } from "@/types/queryExpr";
import { mergeQueryExpr, normalizeExpr, serializeExpr } from "@/utils/queryExprUtils";
import {
  DATE_SHORTCUT_OPTIONS,
  shortcutEndMs,
  shortcutStartMs,
  type DateShortcutKind,
} from "@/utils/dateShortcuts";

type FieldKey = "search" | "tag" | "excludeTag" | "assetType" | "untagged" | "facetHasAny" | "facetMissing" | MetadataFilterKey;
type GroupMode = "and" | "or";
type FlatTag = { id: number; name: string; facet: string };
type Row = { id: string; negated: boolean; cond: LeafCond };
type FieldOption = { key: FieldKey; label: string; group: "关键词" | "标签" | "素材" | "颜色" | "定位" | "时间" | "拍摄设备" | "视频"; kind?: "number" | "text" | "date" | "size" | "duration" | "resolution"; ops?: MetadataOp[] };

const NUMERIC_OPS: MetadataOp[] = ["eq", "gt", "gte", "lt", "lte", "between"];
const TEXT_OPS: MetadataOp[] = ["eq", "contains", "in"];
const ENUM_OPS: MetadataOp[] = ["eq", "in"];
const DATE_OPS: MetadataOp[] = ["gte", "lte", "between"];
const FIELD_OPTIONS: FieldOption[] = [
  { key: "search", label: "关键词", group: "关键词" },
  { key: "tag", label: "包含标签", group: "标签" }, { key: "excludeTag", label: "排除标签", group: "标签" }, { key: "untagged", label: "未打标", group: "标签" },
  // W3-3d：分面有任意/没有标签（W2-7 对应；「有主体没有场景」类补漏筛选）
  { key: "facetHasAny", label: "分类有任意标签", group: "标签" }, { key: "facetMissing", label: "分类没有标签", group: "标签" },
  { key: "assetType", label: "素材类型", group: "素材" }, { key: "file_ext", label: "文件格式", group: "素材", kind: "text", ops: ENUM_OPS }, { key: "mime_type", label: "MIME 类型", group: "素材", kind: "text", ops: ENUM_OPS }, { key: "file_size", label: "文件大小", group: "素材", kind: "size", ops: NUMERIC_OPS }, { key: "width", label: "宽度", group: "素材", kind: "number", ops: NUMERIC_OPS }, { key: "height", label: "高度", group: "素材", kind: "number", ops: NUMERIC_OPS }, { key: "resolution", label: "分辨率", group: "素材", kind: "resolution", ops: NUMERIC_OPS }, { key: "aspect_ratio", label: "宽高比", group: "素材", kind: "number", ops: NUMERIC_OPS },
  { key: "taken_at", label: "拍摄时间", group: "时间", kind: "date", ops: DATE_OPS }, { key: "created_at", label: "入库时间", group: "时间", kind: "date", ops: DATE_OPS }, { key: "modified_at", label: "修改时间", group: "时间", kind: "date", ops: DATE_OPS },
  { key: "camera", label: "相机", group: "拍摄设备", kind: "text", ops: TEXT_OPS }, { key: "lens", label: "镜头", group: "拍摄设备", kind: "text", ops: TEXT_OPS }, { key: "iso", label: "ISO", group: "拍摄设备", kind: "number", ops: NUMERIC_OPS }, { key: "aperture", label: "光圈", group: "拍摄设备", kind: "number", ops: NUMERIC_OPS }, { key: "shutter", label: "快门", group: "拍摄设备", kind: "text", ops: TEXT_OPS }, { key: "focal", label: "焦距", group: "拍摄设备", kind: "number", ops: NUMERIC_OPS },
  { key: "duration_ms", label: "视频时长", group: "视频", kind: "duration", ops: NUMERIC_OPS }, { key: "video_codec", label: "视频编码", group: "视频", kind: "text", ops: TEXT_OPS }, { key: "audio_codec", label: "音频编码", group: "视频", kind: "text", ops: TEXT_OPS },
  // FB2-08（§14.9）：算法主色检索维度。色相是环形量：介于 345 至 15 表示跨过 0° 的红色区间
  // （后端编译为双区间 OR，search_query.rs 对 dominant_hue 的 min>max 特判），其他字段的区间倒置仍是错误。
  { key: "dominant_hue", label: "主色色相（0-359，可跨 0°）", group: "颜色", kind: "number", ops: NUMERIC_OPS },
  { key: "dominant_sat", label: "主色饱和度（0-100）", group: "颜色", kind: "number", ops: NUMERIC_OPS },
  { key: "dominant_lum", label: "主色明度（0-100）", group: "颜色", kind: "number", ops: NUMERIC_OPS },
  // W3-3a：定位字段组（Q4 裁决：地图砍了，筛选留着；后端白名单 V18 已就绪）
  { key: "latitude", label: "纬度", group: "定位", kind: "number", ops: NUMERIC_OPS },
  { key: "longitude", label: "经度", group: "定位", kind: "number", ops: NUMERIC_OPS },
  { key: "has_location", label: "有无定位", group: "定位", kind: "text", ops: ENUM_OPS },
];
const OP_LABELS: Record<MetadataOp, string> = { eq: "等于", in: "属于任一", contains: "包含", gt: "大于", gte: "大于等于", lt: "小于", lte: "小于等于", between: "介于" };
let rowSeq = 0;
const uid = () => `query-row-${++rowSeq}`;
const controlClass = "ui-control h-8 min-w-0 px-2 text-xs";

export default function QueryBuilder() {
  const { expr, setExpr, clearQuery, resolvedTags } = useSuperSearchStore(
    useShallow((s) => ({ expr: s.expr, setExpr: s.setExpr, clearQuery: s.clearQuery, resolvedTags: s.resolvedTags })),
  );
  const tagTree = useTagStore((s) => s.tree); const tagsLoading = useTagStore((s) => s.loading);
  const [mode, setMode] = useState<GroupMode>("and"); const [rows, setRows] = useState<Row[]>([]);
  const [formulaWarning, setFormulaWarning] = useState<string | null>(null);
  const lastLocalSignature = useRef<string | null>(null);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { if (tagTree.length === 0 && !tagsLoading) void useTagStore.getState().refresh(); }, [tagTree.length, tagsLoading]);
  const flatTags = useMemo(() => {
    const out: FlatTag[] = []; const walk = (nodes: import("@/types/tag").TagNode[], facet: string) => { for (const node of nodes) { const nextFacet = node.tag.facetKey || facet; out.push({ id: node.tag.id, name: node.tag.name, facet: nextFacet }); walk(node.children, nextFacet); } };
    // W0-3：从根节点自身开始收集（find_or_create_canonical 建的是根级标签，
    // 旧写法 walk(root.children) 会漏掉全部根级标签，导致下拉一个标签都选不到）
    for (const root of tagTree) { const rootFacet = root.tag.facetKey; out.push({ id: root.tag.id, name: root.tag.name, facet: rootFacet }); walk(root.children, rootFacet); } return out;
  }, [tagTree]);
  // §9.8：resolvedTags 里 tagStore 找不到的 id → synthetic option（保留名称，绝不退回「选择标签」）
  const syntheticTags = useMemo(() => {
    const known = new Set(flatTags.map((t) => t.id));
    return resolvedTags.filter((r) => !known.has(r.tagId)).map((r) => ({ id: r.tagId, name: r.text, facet: r.facetKey }));
  }, [flatTags, resolvedTags]);
  const allTagOptions = useMemo(() => [...flatTags, ...syntheticTags], [flatTags, syntheticTags]);
  useEffect(() => {
    const signature = expr ? serializeExpr(expr) : "";
    if (lastLocalSignature.current === signature) {
      lastLocalSignature.current = null;
      return;
    }
    if (commitTimer.current) clearTimeout(commitTimer.current);
    const model = exprToRows(expr);
    if (model.unsupported) {
      // §9.6.1：嵌套树只显示只读摘要，不渲染可编辑行（防误编辑回写破坏结构）
      setMode("and");
      setRows([]);
      setFormulaWarning(unsupportedMessage(expr));
      return;
    }
    setMode(model.mode);
    setRows(model.rows);
    setFormulaWarning(null);
  }, [expr ? serializeExpr(expr) : ""]);
  useEffect(() => () => { if (commitTimer.current) clearTimeout(commitTimer.current); }, []);
  const commit = (nextRows: Row[], nextMode = mode) => {
    if (formulaWarning) {
      // §9.6.1：嵌套模式下只允许「新条件与整棵现有 expr 以 AND 合并」
      const leafExpr = rowsToExpr(nextRows, nextMode);
      if (!leafExpr || !expr) {
        setRows(nextRows); setMode(nextMode); return; // 未完成，等待用户补全
      }
      const merged = normalizeExpr(mergeQueryExpr(expr, leafExpr) as QueryExpr);
      const signature = merged ? serializeExpr(merged) : "";
      setRows([]); setMode("and");
      lastLocalSignature.current = signature;
      setExpr(merged);
      return;
    }
    const nextExpr = rowsToExpr(nextRows, nextMode);
    const signature = nextExpr ? serializeExpr(nextExpr) : "";
    setRows(nextRows); setMode(nextMode); setFormulaWarning(null);
    lastLocalSignature.current = signature;
    setExpr(nextExpr);
  };
  const addRow = () => commit([...rows, { id: uid(), negated: false, cond: makeCond("tag", allTagOptions) }]);
  const updateRow = (id: string, patch: Partial<Row>) => commit(rows.map((row) => row.id === id ? { ...row, ...patch } : row));
  const clearAll = () => { if (commitTimer.current) clearTimeout(commitTimer.current); lastLocalSignature.current = ""; setRows([]); setFormulaWarning(null); clearQuery(); };

  return <section className="overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)]" aria-label="条件公式">
    <div className="flex min-h-10 items-center gap-2 border-b border-[var(--color-border)] px-3 py-2"><span className="text-xs font-semibold text-[var(--color-text)]">筛选条件</span><span className="text-[11px] text-[var(--color-text-tertiary)]">AI 生成后可继续修改</span>{rows.length > 0 && <button type="button" onClick={clearAll} className="ml-auto text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text)]">清除全部</button>}</div>
    <div className="px-3 py-2.5"><div className="mb-2 flex items-center gap-2 text-xs text-[var(--color-text-secondary)]"><span>符合</span><select aria-label="条件连接方式" value={mode} disabled={Boolean(formulaWarning)} onChange={(e) => commit(rows, e.target.value as GroupMode)} className={`${controlClass} w-28 font-medium text-[var(--color-text)]`}><option value="and">全部条件</option><option value="or">任一条件</option></select></div>
      {formulaWarning && <p className="mb-2 border-l-2 border-[var(--color-status)] pl-2 text-[11px] leading-5 text-[var(--color-status)]">{formulaWarning}</p>}
      {rows.length === 0 ? <button type="button" onClick={addRow} className="flex h-10 w-full items-center justify-center border border-dashed border-[var(--color-border)] text-xs text-[var(--color-text-secondary)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]">+ 添加第一个条件</button> : <div className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">{rows.map((row, index) => <ConditionRow key={row.id} row={row} prefix={index === 0 ? "当" : mode === "and" ? "并且" : "或者"} allTagOptions={allTagOptions} onChange={(patch) => updateRow(row.id, patch)} onRemove={() => commit(rows.filter((item) => item.id !== row.id))} />)}</div>}
      {rows.length > 0 && <button type="button" onClick={addRow} className="mt-2 h-8 px-1 text-xs font-medium text-[var(--color-status)] hover:opacity-80">+ 添加条件</button>}
    </div>
  </section>;
}

/** §9.6.1：嵌套树只读摘要文案（含条件数量） */
function unsupportedMessage(expr?: QueryExpr): string {
  const n = expr ? countLeafNodes(expr) : 0;
  return `复杂条件（${n} 项）：当前包含 OR / 嵌套排除，无法在简洁模式中展开，原条件仍然有效。可在上方条件条逐项移除；新增条件将以「并且」合并到现有条件。`;
}

function countLeafNodes(e: QueryExpr): number {
  if (e.op === "leaf") return 1;
  if (e.op === "not") return countLeafNodes(e.child);
  return e.children.reduce((sum, c) => sum + countLeafNodes(c), 0);
}

function ConditionRow({ row, prefix, allTagOptions, onChange, onRemove }: { row: Row; prefix: string; allTagOptions: FlatTag[]; onChange: (patch: Partial<Row>) => void; onRemove: () => void }) {
  const field = fieldFromCond(row.cond);
  return <div className="grid min-h-11 grid-cols-[48px_minmax(120px,0.8fr)_minmax(108px,0.65fr)_minmax(180px,1.6fr)_32px] items-center gap-2 py-1.5 max-[800px]:grid-cols-[44px_minmax(105px,1fr)_minmax(96px,1fr)_minmax(130px,1.4fr)_30px]"><span className="pl-1 text-[11px] text-[var(--color-text-tertiary)]">{prefix}</span><FieldSelect value={field} onChange={(next) => onChange({ cond: makeCond(next, allTagOptions), negated: false })} /><ConditionOperator cond={row.cond} negated={row.negated} onChange={onChange} /><ConditionValue cond={row.cond} allTagOptions={allTagOptions} onChange={(cond) => onChange({ cond })} /><button type="button" onClick={onRemove} className="flex size-7 items-center justify-center rounded text-base text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-danger)]" aria-label="删除条件" title="删除条件">×</button></div>;
}
function FieldSelect({ value, onChange }: { value: FieldKey; onChange: (value: FieldKey) => void }) { const groups = ["关键词", "标签", "素材", "颜色", "定位", "时间", "拍摄设备", "视频"] as const; return <select aria-label="条件字段" value={value} onChange={(e) => onChange(e.target.value as FieldKey)} className={`${controlClass} w-full`}>{groups.map((group) => <optgroup key={group} label={group}>{FIELD_OPTIONS.filter((item) => item.group === group).map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</optgroup>)}</select>; }

function ConditionOperator({ cond, negated, onChange }: { cond: LeafCond; negated: boolean; onChange: (patch: Partial<Row>) => void }) {
  if (cond.type === "facetHasAny" || cond.type === "facetMissing") return <span className="px-2 text-xs text-[var(--color-text-tertiary)]">{cond.type === "facetHasAny" ? "存在" : "缺失"}</span>;
  if (cond.type === "metadata") { const ops = FIELD_OPTIONS.find((item) => item.key === cond.filter.key)?.ops ?? NUMERIC_OPS; return <select aria-label="条件操作符" value={cond.filter.op} onChange={(e) => onChange({ cond: { ...cond, filter: changeMetadataOp(cond.filter, e.target.value as MetadataOp) } })} className={`${controlClass} w-full`}>{ops.map((op) => <option key={op} value={op}>{OP_LABELS[op]}</option>)}</select>; }
  const excluded = cond.type === "excludeTag" || negated; return <select aria-label="条件操作符" value={excluded ? "not" : "is"} onChange={(e) => onChange({ negated: e.target.value === "not" })} className={`${controlClass} w-full`}><option value="is">是</option><option value="not">不是</option></select>;
}

function ConditionValue({ cond, allTagOptions, onChange }: { cond: LeafCond; allTagOptions: FlatTag[]; onChange: (cond: LeafCond) => void }) {
  if (cond.type === "untagged") return <span className="px-2 text-xs text-[var(--color-text-secondary)]">没有任何标签的素材</span>;
  if (cond.type === "assetType") return <select aria-label="条件值" value={cond.value} onChange={(e) => onChange({ ...cond, value: e.target.value as AssetType })} className={`${controlClass} w-full`}><option value="all">全部素材</option><option value="image">图片</option><option value="video">视频</option></select>;
  if (cond.type === "search") return <DraftInput ariaLabel="条件值" placeholder="输入关键词" displayValue={cond.value} onCommit={(v) => onChange({ ...cond, value: v })} className={`${controlClass} w-full`} />;
  if (cond.type === "facetHasAny" || cond.type === "facetMissing") {
    // W3-3d：分面选择（从 tagStore facets 派生；无标签树也能用）
    const facets = [...new Set(allTagOptions.map((t) => t.facet))];
    const known = facets.includes(cond.facetKey);
    return <select aria-label="条件值" value={cond.facetKey} onChange={(e) => onChange({ ...cond, facetKey: e.target.value })} className={`${controlClass} w-full`}>{!known && cond.facetKey ? <option value={cond.facetKey}>{cond.facetKey}</option> : null}{facets.map((f) => <option key={f} value={f}>{f}</option>)}</select>;
  }
  if (cond.type === "tag" || cond.type === "excludeTag") {
    // W3-3b：optgroup 按分面分组（新建分面自动成为一组，零代码改动）
    // W3-3c：多选 + 「同时满足」勾选（协议早就支持 mode:all，此前 UI 只取第一个）
    const selectedIds = new Set(cond.tagIds.map(String));
    // §9.8：已有非空 tagId 时，两边都找不到 → 显示「标签 #id」，绝不退回「选择标签」
    const options = [...allTagOptions];
    for (const id of cond.tagIds) {
      if (!options.some((t) => t.id === id)) {
        options.push({ id, name: `标签 #${id}`, facet: cond.facetKey || "custom" });
      }
    }
    const byFacet = new Map<string, FlatTag[]>();
    for (const t of options) {
      const list = byFacet.get(t.facet) ?? [];
      list.push(t);
      byFacet.set(t.facet, list);
    }
    return <div className="grid grid-cols-[minmax(0,1fr)_92px] gap-2">
      <select aria-label="条件值" multiple value={cond.tagIds.map(String)} onChange={(e) => { const ids = Array.from(e.target.selectedOptions, (o) => Number(o.value)).filter(Boolean); const facets = new Set(ids.map((id) => options.find((t) => t.id === id)?.facet).filter(Boolean) as string[]); onChange({ ...cond, tagIds: ids, facetKey: [...facets][0] ?? cond.facetKey }); }} className={`${controlClass} h-auto max-h-24 w-full`} size={Math.min(4, Math.max(2, options.length))}>
        {[...byFacet.entries()].map(([facet, tags]) => <optgroup key={facet} label={facet}>{tags.map((tag) => <option key={tag.id} value={tag.id}>{selectedIds.has(String(tag.id)) ? "✓ " : ""}{tag.name}</option>)}</optgroup>)}
      </select>
      {cond.type === "tag"
        ? <select aria-label="标签范围" value={cond.mode === "all" ? "all" : cond.includeDescendants ? "desc" : "self"} onChange={(e) => { const v = e.target.value; onChange(v === "all" ? { ...cond, mode: "all", includeDescendants: false } : { ...cond, mode: "any", includeDescendants: v === "desc" }); }} className={`${controlClass} w-full`}><option value="desc">含子标签</option><option value="self">仅当前</option><option value="all">同时满足</option></select>
        : <span />}
    </div>;
  }
  return <MetadataValue filter={cond.filter} onChange={(filter) => onChange({ ...cond, filter })} />;
}
function MetadataValue({ filter, onChange }: { filter: MetadataFilter; onChange: (filter: MetadataFilter) => void }) {
  const kind = FIELD_OPTIONS.find((item) => item.key === filter.key)?.kind ?? "number";
  if (filter.op === "between")
    return (
      <div className="grid grid-cols-[minmax(0,1fr)_16px_minmax(0,1fr)] items-center gap-1">
        <ValueInput kind={kind} value={filter.min} dateSide="start" onChange={(min) => onChange({ ...filter, min })} />
        <span className="text-center text-[11px] text-[var(--color-text-tertiary)]">至</span>
        <ValueInput kind={kind} value={filter.max} dateSide="end" onChange={(max) => onChange({ ...filter, max })} />
      </div>
    );
  if (filter.op === "in") return <DraftInput ariaLabel="条件值" placeholder="多个值用逗号分隔" displayValue={(filter.values ?? []).join(", ")} onCommit={(raw) => onChange({ ...filter, values: raw.split(/[,，]/).map((x) => x.trim()).filter(Boolean) })} className={`${controlClass} w-full`} />;
  // U-7 ②：日期快捷的语义与 op 绑定 —— gte/min 侧写期初，lte/max 侧写期末
  return <ValueInput kind={kind} value={filter.value} dateSide={filter.op === "lte" ? "end" : "start"} onChange={(value) => onChange({ ...filter, value })} />;
}
function ValueInput({ kind, value, onChange, dateSide }: { kind: NonNullable<FieldOption["kind"]>; value: string | number | undefined; dateSide?: "start" | "end"; onChange: (value: string | number | undefined) => void }) {
  if (kind === "date") return <DateValue value={value} side={dateSide ?? "start"} onChange={onChange} />;
  if (kind === "text") return <DraftInput ariaLabel="条件值" placeholder="输入值" displayValue={String(value ?? "")} onCommit={(raw) => onChange(raw)} className={`${controlClass} w-full`} />;
  if (kind === "size") return <SizeValue value={value} onChange={onChange} />;
  const factor = kind === "duration" ? 1000 : kind === "resolution" ? 1_000_000 : 1;
  const suffix = kind === "duration" ? "秒" : kind === "resolution" ? "MP" : "";
  return <DraftInput ariaLabel="条件值" type="number" step={kind === "number" ? "any" : "0.1"} placeholder="输入数值" suffix={suffix} displayValue={typeof value === "number" ? String(value / factor) : ""} onCommit={(raw) => { if (raw.trim() === "") { onChange(undefined); return; } const n = Number(raw); onChange(Number.isNaN(n) ? undefined : n * factor); }} className={`${controlClass} w-full ${suffix ? "pr-9" : ""}`} />;
}
type SizeUnit = "KB" | "MB" | "GB";
const SIZE_FACTORS: Record<SizeUnit, number> = { KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024 };
const DEFAULT_SIZE_UNIT: SizeUnit = "MB";
/** U-7 ①：size 字段（file_size）单位下拉 KB/MB/GB —— 显示按所选单位换算，提交始终是字节（后端不碰单位）。
 *  独立子组件承载 useState（ValueInput 本身分支多，不能在其中条件性调用 hooks）。 */
function SizeValue({ value, onChange }: { value: string | number | undefined; onChange: (v: string | number | undefined) => void }) {
  const [unit, setUnit] = useState<SizeUnit>(DEFAULT_SIZE_UNIT);
  const factor = SIZE_FACTORS[unit];
  const display = typeof value === "number" && Number.isFinite(value) ? String(Math.round((value / factor) * 1000) / 1000) : "";
  return (
    <div className="flex min-w-0 items-stretch gap-1">
      <DraftInput ariaLabel="条件值" type="number" step="0.1" placeholder="输入数值" displayValue={display} onCommit={(raw) => { if (raw.trim() === "") { onChange(undefined); return; } const n = Number(raw); onChange(Number.isNaN(n) ? undefined : Math.round(n * factor)); }} className={`${controlClass} w-full`} />
      <select aria-label="数值单位" value={unit} onChange={(e) => setUnit(e.target.value as SizeUnit)} className={`${controlClass} w-16 shrink-0 text-[var(--color-text-secondary)]`}>
        <option value="KB">KB</option><option value="MB">MB</option><option value="GB">GB</option>
      </select>
    </div>
  );
}
/** U-7 ②：date 快捷（今天/本周/本月/今年）—— start 侧（gte/区间下限）写期初，end 侧（lte/区间上限）写期末；
 *  选完立即落值并回到「自定义」，之后仍可手工改日期。 */
function DateValue({ value, side, onChange }: { value: string | number | undefined; side: "start" | "end"; onChange: (v: string | number | undefined) => void }) {
  const [pick, setPick] = useState("");
  return (
    <div className="flex min-w-0 items-stretch gap-1">
      <input aria-label="条件值" type="date" value={epochToDate(value)} onChange={(e) => onChange(dateToEpoch(e.target.value))} className={`${controlClass} w-full`} />
      <select aria-label="日期快捷" value={pick} onChange={(e) => { const kind = e.target.value as DateShortcutKind | ""; if (!kind) return; const now = new Date(); onChange(side === "end" ? shortcutEndMs(kind, now) : shortcutStartMs(kind, now)); setPick(""); }} className={`${controlClass} w-[72px] shrink-0 text-[var(--color-text-secondary)]`}>
        <option value="">自定义</option>
        {DATE_SHORTCUT_OPTIONS.map((o) => <option key={o.kind} value={o.kind}>{o.label}</option>)}
      </select>
    </div>
  );
}
/** 文本/数值输入的本地 draft：输入时不提交到 store（不触发后端查询），失焦或 Enter 才提交。
 *  P0-1：解决「每输入一个字符 → commit → 行重建 → 失焦」问题。 */
function DraftInput({ ariaLabel = "条件值", displayValue, onCommit, className, placeholder, type = "text", step, suffix }: { ariaLabel?: string; displayValue: string; onCommit: (display: string) => void; className?: string; placeholder?: string; type?: string; step?: string; suffix?: string }) {
  const [draft, setDraft] = useState(displayValue);
  const lastCommitted = useRef(displayValue);
  const dirty = useRef(false);
  useEffect(() => {
    if (displayValue !== lastCommitted.current) {
      lastCommitted.current = displayValue;
      dirty.current = false;
      setDraft(displayValue);
    }
  }, [displayValue]);
  const commit = () => {
    if (!dirty.current) return;
    dirty.current = false;
    lastCommitted.current = draft;
    onCommit(draft);
  };
  return <div className="relative min-w-0"><input aria-label={ariaLabel} type={type} step={step} value={draft} placeholder={placeholder} className={className} onChange={(e) => { dirty.current = true; setDraft(e.target.value); }} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }} />{suffix && <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[10px] text-[var(--color-text-tertiary)]">{suffix}</span>}</div>;
}

function makeCond(field: FieldKey, flatTags: FlatTag[]): LeafCond { if (field === "search") return { type: "search", value: "" }; if (field === "tag") return { type: "tag", facetKey: flatTags[0]?.facet ?? "scene", tagIds: [], mode: "any", includeDescendants: true }; if (field === "excludeTag") return { type: "excludeTag", facetKey: flatTags[0]?.facet ?? "", tagIds: [] }; if (field === "assetType") return { type: "assetType", value: "image" }; if (field === "untagged") return { type: "untagged" }; if (field === "facetHasAny") return { type: "facetHasAny", facetKey: flatTags[0]?.facet ?? "scene" }; if (field === "facetMissing") return { type: "facetMissing", facetKey: flatTags[0]?.facet ?? "scene" }; const option = FIELD_OPTIONS.find((item) => item.key === field); const op = option?.ops?.[0] ?? "eq"; return { type: "metadata", filter: changeMetadataOp({ key: field, op }, op) }; }
function fieldFromCond(cond: LeafCond): FieldKey { return cond.type === "metadata" ? cond.filter.key : cond.type; }
function changeMetadataOp(filter: MetadataFilter, op: MetadataOp): MetadataFilter { if (op === "between") return { key: filter.key, op, min: filter.min ?? filter.value, max: filter.max ?? filter.value }; if (op === "in") return { key: filter.key, op, values: filter.values ?? (filter.value === undefined ? [] : [filter.value]) }; return { key: filter.key, op, value: filter.value ?? filter.min }; }
function isComplete(cond: LeafCond): boolean { if (cond.type === "tag" || cond.type === "excludeTag") return cond.tagIds.length > 0; if (cond.type === "search") return cond.value.trim().length > 0; if (cond.type !== "metadata") return true; if (cond.filter.op === "between") return cond.filter.min !== undefined && cond.filter.max !== undefined; if (cond.filter.op === "in") return Boolean(cond.filter.values?.length); return cond.filter.value !== undefined && cond.filter.value !== ""; }
function rowsToExpr(rows: Row[], mode: GroupMode): QueryExpr | undefined { const children = rows.filter((row) => isComplete(row.cond)).map((row) => { const leaf: QueryExpr = { op: "leaf", cond: row.cond }; return row.negated ? { op: "not", child: leaf } as QueryExpr : leaf; }); if (!children.length) return undefined; return children.length === 1 ? children[0] : { op: mode, children }; }
function exprToRows(expr?: QueryExpr): { mode: GroupMode; rows: Row[]; unsupported: boolean } { if (!expr) return { mode: "and", rows: [], unsupported: false }; const mode: GroupMode = expr.op === "or" ? "or" : "and"; const children = expr.op === "and" || expr.op === "or" ? expr.children : [expr]; const rows: Row[] = []; let unsupported = false; for (const child of children) { if (child.op === "leaf") rows.push({ id: uid(), negated: false, cond: child.cond }); else if (child.op === "not" && child.child.op === "leaf") rows.push({ id: uid(), negated: true, cond: child.child.cond }); else unsupported = true; } return { mode, rows, unsupported }; }
function epochToDate(value: string | number | undefined): string { if (typeof value !== "number" || !value) return ""; const date = new Date(value); const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000); return local.toISOString().slice(0, 10); }
function dateToEpoch(value: string): number | undefined { return value ? new Date(`${value}T00:00:00`).getTime() : undefined; }
