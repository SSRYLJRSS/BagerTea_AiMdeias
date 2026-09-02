/** 飞书式条件公式构建器：一个条件组 + 多行字段/运算符/值编辑。
 *  FB5-05（§9.6.1）：遇到当前无法编辑的嵌套树（OR/嵌套 NOT）时——
 *  不得把 expr 转成空 rows 回写；显示「复杂条件（N 项）」只读摘要，
 *  新增手动条件时把新 leaf 与整棵现有 expr 以 AND 合并（不破坏内部 OR 分组）。
 *  FB5-05（§9.8）：已有非空 tagId 优先 tagStore options，找不到再从 resolvedTags 注入
 *  synthetic option，两边都找不到时显示「标签 #id」，绝不退回「选择标签」。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { useTagStore } from "@/stores/tagStore";
import { useSuperSearchStore } from "@/stores/superSearchStore";
import type { AssetType, MetadataFilter, MetadataFilterKey, MetadataOp } from "@/types/asset";
import type { LeafCond, QueryExpr } from "@/types/queryExpr";
import type { ShouldClause } from "@/types/superSearch";
import { mergeQueryExpr, normalizeExpr, serializeExpr } from "@/utils/queryExprUtils";
import {
  DATE_SHORTCUT_OPTIONS,
  shortcutEndMs,
  shortcutStartMs,
  type DateShortcutKind,
} from "@/utils/dateShortcuts";

type FieldKey = "search" | "tag" | "excludeTag" | "assetType" | "untagged" | "facetHasAny" | "facetMissing" | MetadataFilterKey;
type GroupMode = "and" | "or";
type FlatTag = { id: number; name: string; facet: string; aliases: string[] };
type TagCondData = { facetKey: string; tagIds: number[]; mode: "any" | "all"; includeDescendants: boolean };
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
  // U-3：色板关系表 UI —— 只暴露 palette_top3（C-1 的 UI 范围决策：前三色）。
  // 值 = 折叠色名（12 hue + 黑/灰/白），eq 单选 + 占比阈值（min 0..1）；多选走 in。
  { key: "palette_top3", label: "前三色包含", group: "颜色", ops: ENUM_OPS },
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
const FIELD_GROUPS = ["关键词", "标签", "素材", "颜色", "定位", "时间", "拍摄设备", "视频"] as const;
const RECENT_FIELDS_KEY = "qb:recent-fields";
const MAX_RECENT_FIELDS = 5;
/** U-1：最近使用字段持久化（localStorage 最多 5 个，最新在前）；读取容错返回 [] */
function readRecentFields(): FieldKey[] {
  try {
    const raw = localStorage.getItem(RECENT_FIELDS_KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((k): k is FieldKey => typeof k === "string" && FIELD_OPTIONS.some((o) => o.key === k)).slice(0, MAX_RECENT_FIELDS);
  } catch {
    return [];
  }
}
function writeRecentFields(list: FieldKey[]) {
  try {
    localStorage.setItem(RECENT_FIELDS_KEY, JSON.stringify(list.slice(0, MAX_RECENT_FIELDS)));
  } catch {
    /* localStorage 不可用时最近使用静默降级 */
  }
}
const OP_LABELS: Record<MetadataOp, string> = { eq: "等于", in: "属于任一", contains: "包含", gt: "大于", gte: "大于等于", lt: "小于", lte: "小于等于", between: "介于" };
let rowSeq = 0;
const uid = () => `query-row-${++rowSeq}`;
const controlClass = "ui-control h-8 min-w-0 px-2 text-xs";

// U-2：标签面板搜索的匹配模式（默认别名）。模式只影响面板「过滤显示哪些标签」，不改后端条件语义。
type TermMatchKey = "exact" | "alias" | "prefix" | "contains" | "fuzzy";
const TERM_MATCH_KEYS: TermMatchKey[] = ["exact", "alias", "prefix", "contains", "fuzzy"];
const TERM_MATCH_LABELS: Record<TermMatchKey, string> = { exact: "精确", alias: "别名", prefix: "前缀", contains: "包含", fuzzy: "纠错" };
const DEFAULT_TERM_MATCH: TermMatchKey = "alias";
function tagMatch(opt: FlatTag, qRaw: string, match: TermMatchKey): boolean {
  const q = qRaw.trim().toLowerCase();
  if (!q) return true;
  const name = opt.name.toLowerCase();
  const hay = [name, ...(opt.aliases ?? []).map((a) => a.toLowerCase())];
  const anyHay = (fn: (s: string) => boolean) => hay.some(fn);
  switch (match) {
    case "exact":
      return name === q;
    case "prefix":
      return anyHay((s) => s.startsWith(q));
    case "alias": // 别名：名称或别名包含（默认）
      return anyHay((s) => s.includes(q));
    case "contains": // 包含：仅名称包含（比别名严格）
      return name.includes(q);
    case "fuzzy": // 纠错：允许漏字/错序（子序列容错）
      return anyHay((s) => { let i = 0; for (const ch of q) { i = s.indexOf(ch, i); if (i < 0) return false; i += 1; } return true; });
  }
}

export default function QueryBuilder() {
  const { expr, setExpr, clearQuery, resolvedTags, plan, setPlanShould } = useSuperSearchStore(
    useShallow((s) => ({ expr: s.expr, setExpr: s.setExpr, clearQuery: s.clearQuery, resolvedTags: s.resolvedTags, plan: s.plan, setPlanShould: s.setPlanShould })),
  );
  const tagTree = useTagStore((s) => s.tree); const tagsLoading = useTagStore((s) => s.loading);
  const [mode, setMode] = useState<GroupMode>("and"); const [rows, setRows] = useState<Row[]>([]);
  const [formulaWarning, setFormulaWarning] = useState<string | null>(null);
  // U-4：嵌套树的只读树形查看默认收起，可展开
  const [treeOpen, setTreeOpen] = useState(false);
  const lastLocalSignature = useRef<string | null>(null);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { if (tagTree.length === 0 && !tagsLoading) void useTagStore.getState().refresh(); }, [tagTree.length, tagsLoading]);
  const flatTags = useMemo(() => {
    const out: FlatTag[] = []; const walk = (nodes: import("@/types/tag").TagNode[], facet: string) => { for (const node of nodes) { const nextFacet = node.tag.facetKey || facet; out.push({ id: node.tag.id, name: node.tag.name, facet: nextFacet, aliases: node.tag.aliases ?? [] }); walk(node.children, nextFacet); } };
    // W0-3：从根节点自身开始收集（find_or_create_canonical 建的是根级标签，
    // 旧写法 walk(root.children) 会漏掉全部根级标签，导致下拉一个标签都选不到）
    for (const root of tagTree) { const rootFacet = root.tag.facetKey; out.push({ id: root.tag.id, name: root.tag.name, facet: rootFacet, aliases: root.tag.aliases ?? [] }); walk(root.children, rootFacet); } return out;
  }, [tagTree]);
  // §9.8：resolvedTags 里 tagStore 找不到的 id → synthetic option（保留名称，绝不退回「选择标签」）
  const syntheticTags = useMemo(() => {
    const known = new Set(flatTags.map((t) => t.id));
    return resolvedTags.filter((r) => !known.has(r.tagId)).map((r) => ({ id: r.tagId, name: r.text, facet: r.facetKey, aliases: [] }));
  }, [flatTags, resolvedTags]);
  const allTagOptions = useMemo(() => [...flatTags, ...syntheticTags], [flatTags, syntheticTags]);
  // U-4：嵌套树（formulaWarning="nested"）的只读展示数据——展开后逐行列出 AND/OR/NOT 与叶子
  const treeRows = useMemo(() => {
    if (!expr || formulaWarning !== "nested") return [];
    const nameOf = (id: number) => allTagOptions.find((t) => t.id === id)?.name ?? `标签 #${id}`;
    return buildTreeRows(expr, nameOf);
  }, [expr, formulaWarning, allTagOptions]);
  const treeLeafCount = useMemo(() => (expr ? countLeafNodes(expr) : 0), [expr]);
  useEffect(() => {
    const signature = expr ? serializeExpr(expr) : "";
    if (lastLocalSignature.current === signature) {
      lastLocalSignature.current = null;
      return;
    }
    if (commitTimer.current) clearTimeout(commitTimer.current);
    const model = exprToRows(expr);
    if (model.unsupported) {
      // §9.6.1/U-4：嵌套树只读降级——不渲染可编辑行（防误编辑回写破坏结构），
      // 摘要改为可展开的树形只读视图；新增条件仍以 AND 与整棵现有树合并。
      setMode("and");
      setRows([]);
      setFormulaWarning("nested");
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
  // U-5：加分项（should）只读区所需数据 —— plan.should 为 store 单源；加分项是非嵌套叶子（ShouldClause.cond）
  const shouldList = plan?.should ?? [];
  const shouldMin = plan?.minimumShouldMatch ?? 0;
  const setShould = (next: typeof shouldList, min?: number) => setPlanShould(next, min ?? Math.min(shouldMin, next.length));
  const patchShould = (index: number, next: ShouldClause) => setShould(shouldList.map((x, i) => (i === index ? next : x)), shouldMin);

  return <section className="overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)]" aria-label="条件公式">
    <div className="flex min-h-10 items-center gap-2 border-b border-[var(--color-border)] px-3 py-2"><span className="text-xs font-semibold text-[var(--color-text)]">筛选条件</span><span className="text-[11px] text-[var(--color-text-tertiary)]">AI 生成后可继续修改</span>{rows.length > 0 && <button type="button" onClick={clearAll} className="ml-auto text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text)]">清除全部</button>}</div>
    <div className="px-3 py-2.5"><div className="mb-2 flex items-center gap-2 text-xs text-[var(--color-text-secondary)]"><span>符合</span><select aria-label="条件连接方式" value={mode} disabled={Boolean(formulaWarning)} onChange={(e) => commit(rows, e.target.value as GroupMode)} className={`${controlClass} w-28 font-medium text-[var(--color-text)]`}><option value="and">全部条件</option><option value="or">任一条件</option></select></div>
      {formulaWarning === "nested" && expr && (
        <div className="mb-2 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
          <button
            type="button"
            aria-expanded={treeOpen}
            aria-controls="nested-condition-tree"
            onClick={() => setTreeOpen((o) => !o)}
            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] font-medium text-[var(--color-status)] hover:bg-[var(--color-surface-hover)]"
          >
            <span aria-hidden="true" className="text-[10px]">{treeOpen ? "▾" : "▸"}</span>
            <span>复杂条件（{treeLeafCount} 项）：{treeOpen ? "收起只读树形查看" : "展开只读树形查看"}</span>
          </button>
          {treeOpen && (
            <div id="nested-condition-tree" className="max-h-56 overflow-y-auto border-t border-[var(--color-border)] px-3 py-1.5 text-[11px] leading-5">
              {treeRows.map((r) => (
                <div
                  key={r.id}
                  className={r.op ? "font-medium text-[var(--color-text-secondary)]" : "text-[var(--color-text)]"}
                  style={{ paddingLeft: `${r.depth * 14}px` }}
                >
                  {r.op ? r.text : `· ${r.text}`}
                </div>
              ))}
            </div>
          )}
          <p className="px-3 py-1 text-[10px] leading-4 text-[var(--color-text-tertiary)]">嵌套树只读：可「并且」追加新条件，或在上方条件条逐项移除。</p>
        </div>
      )}
      {rows.length === 0 ? <button type="button" onClick={addRow} className="flex h-10 w-full items-center justify-center border border-dashed border-[var(--color-border)] text-xs text-[var(--color-text-secondary)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]">+ 添加第一个条件</button> : <div className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">{rows.map((row, index) => <ConditionRow key={row.id} row={row} prefix={index === 0 ? "当" : mode === "and" ? "并且" : "或者"} allTagOptions={allTagOptions} onChange={(patch) => updateRow(row.id, patch)} onRemove={() => commit(rows.filter((item) => item.id !== row.id))} />)}</div>}
      {rows.length > 0 && <button type="button" onClick={addRow} className="mt-2 h-8 px-1 text-xs font-medium text-[var(--color-status)] hover:opacity-80">+ 添加条件</button>}
      {/* U-5：加分项（should）区 —— 满足加分不淘汰；仅叶子；行编辑直接写 store.plan.should */}
      <div className="mt-3 border-t border-[var(--color-border)] pt-2">
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-[var(--color-text)]">加分项</span>
          <span className="text-[11px] text-[var(--color-text-tertiary)]">满足越多排越前 · 不满足不淘汰</span>
          {shouldList.length > 0 && (
            <span className="ml-auto flex items-center gap-1 text-[11px] text-[var(--color-text-secondary)]">
              至少满足
              <select aria-label="至少满足" value={shouldMin} onChange={(e) => setShould(shouldList, Number(e.target.value))} className={`${controlClass} w-16`}>
                {Array.from({ length: shouldList.length + 1 }, (_, i) => <option key={i} value={i}>{i === 0 ? "0（不限）" : i === shouldList.length ? `${i}（全部）` : i}</option>)}
              </select>
              项
            </span>
          )}
        </div>
        {shouldList.map((sc, i) => {
          const field = fieldFromCond(sc.cond);
          return (
            <div key={`should-${i}`} className="mb-1.5 grid grid-cols-[40px_minmax(110px,0.8fr)_minmax(92px,0.55fr)_minmax(150px,1.5fr)_64px_28px] items-center gap-2 max-[900px]:grid-cols-[36px_minmax(100px,1fr)_minmax(88px,1fr)_minmax(130px,1.4fr)_60px_26px]">
              <span className="pl-1 text-[11px] text-[var(--color-text-tertiary)]">{i === 0 ? "当" : "或"}</span>
              <FieldSelect value={field} onChange={(next) => patchShould(i, { ...sc, cond: makeCond(next, allTagOptions) })} />
              <ConditionOperator cond={sc.cond} negated={false} onChange={(p) => { if (p.cond) patchShould(i, { ...sc, cond: p.cond }); }} />
              <ConditionValue cond={sc.cond} allTagOptions={allTagOptions} onChange={(cond) => patchShould(i, { ...sc, cond })} />
              <select aria-label="加分权重" value={String(sc.weight)} onChange={(e) => patchShould(i, { ...sc, weight: Number(e.target.value) })} className={`${controlClass} w-full`}>
                <option value="0.5">略微</option><option value="1">一般</option><option value="2">强偏好</option>
              </select>
              <button type="button" aria-label={`移除加分项 ${i + 1}`} onClick={() => setShould(shouldList.filter((_, j) => j !== i))} className="flex size-7 items-center justify-center rounded text-base text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-danger)]">×</button>
            </div>
          );
        })}
        {shouldList.length === 0 && <p className="mb-1 text-[11px] text-[var(--color-text-tertiary)]">把「最好有 / 优先」倾向加在这里：只参与排序，不淘汰结果。</p>}
        <button type="button" onClick={() => setShould([...shouldList, { cond: makeCond("tag", allTagOptions), weight: 1, label: "" }])} className="mt-1 h-7 px-1 text-xs font-medium text-[var(--color-status)] hover:opacity-80">＋ 添加加分项</button>
      </div>
    </div>
  </section>;
}

/** U-4：嵌套树的只读展示行。op 行为组标记（全部满足/并且/或者/排除），叶子行为条件文本。 */
type TreeRowItem = { id: string; depth: number; op?: "and" | "or" | "not"; text: string };

function buildTreeRows(e: QueryExpr, nameOf: (id: number) => string): TreeRowItem[] {
  const rows: TreeRowItem[] = [];
  const push = (n: QueryExpr, depth: number, root: boolean) => {
    if (n.op === "leaf") {
      rows.push({ id: `tree-${rows.length}`, depth, text: describeLeafCond(n.cond, nameOf) });
      return;
    }
    if (n.op === "not") {
      rows.push({ id: `tree-${rows.length}`, depth, op: "not", text: "排除" });
      push(n.child, depth + 1, false);
      return;
    }
    rows.push({ id: `tree-${rows.length}`, depth, op: n.op, text: n.op === "and" ? (root ? "全部满足" : "并且") : root ? "任一满足" : "或者" });
    for (const c of n.children) push(c, depth + 1, false);
  };
  push(e, 0, true);
  return rows;
}

const LEAF_META_LABELS: Record<string, string> = {
  file_ext: "格式", mime_type: "MIME", width: "宽", height: "高", resolution: "分辨率", aspect_ratio: "宽高比",
  file_size: "文件大小", duration_ms: "视频时长", taken_at: "拍摄时间", created_at: "入库时间", modified_at: "修改时间",
  camera: "相机", lens: "镜头", iso: "ISO", aperture: "光圈", shutter: "快门", focal: "焦距",
  video_codec: "视频编码", audio_codec: "音频编码", folder: "文件夹", palette_top3: "前三色",
};
const LEAF_OP_TEXT: Record<string, string> = { eq: "=", in: "属于", contains: "含", gt: ">", gte: "≥", lt: "<", lte: "≤" };

/** 叶子条件 → 树形只读视图的可读文本（tag 名称经 nameOf 解析，找不到显示「标签 #id」）。 */
function describeLeafCond(cond: LeafCond, nameOf: (id: number) => string): string {
  switch (cond.type) {
    case "search":
      return cond.value;
    case "assetType":
      return cond.value === "image" ? "类型：图片" : cond.value === "video" ? "类型：视频" : "类型：全部";
    case "untagged":
      return "未打标";
    case "facetHasAny":
      return `「${cond.facetKey}」分类有任意标签`;
    case "facetMissing":
      return `「${cond.facetKey}」分类没有标签`;
    case "tag":
    case "excludeTag": {
      const names = cond.tagIds.map(nameOf).join("、");
      return cond.type === "excludeTag" ? `排除：${names || cond.facetKey}` : `标签：${names || "（未选择）"}`;
    }
    case "metadata": {
      const f = cond.filter;
      const label = LEAF_META_LABELS[f.key] ?? f.key;
      if (f.key === "palette_top3" && f.op === "eq" && typeof f.value === "string" && typeof f.min === "number" && f.min > 0) {
        return `${label}含 ${f.value}（占 ≥${Math.round(f.min * 100)}%）`;
      }
      if (f.op === "between") return `${label} ${f.min ?? ""}~${f.max ?? ""}`;
      if (f.op === "in") return `${label} ∈ ${(f.values ?? []).join("、")}`;
      return `${label} ${LEAF_OP_TEXT[f.op] ?? f.op} ${f.value ?? ""}`;
    }
  }
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
function FieldSelect({ value, onChange }: { value: FieldKey; onChange: (value: FieldKey) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(-1);
  const [recent, setRecent] = useState<FieldKey[]>(() => readRecentFields());
  const [pos, setPos] = useState<{ x: number; width: number; down: number | null; up: number | null } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const portalHost = useRef<HTMLDivElement | null>(null);
  const listId = useMemo(() => `field-list-${uid()}`, []);

  useEffect(() => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    portalHost.current = host;
    return () => { host.remove(); };
  }, []);

  const labelOf = (key: FieldKey) => FIELD_OPTIONS.find((o) => o.key === key)?.label ?? key;

  const choose = (key: FieldKey) => {
    setRecent((prev) => {
      const next = [key, ...prev.filter((k) => k !== key)].slice(0, MAX_RECENT_FIELDS);
      writeRecentFields(next);
      return next;
    });
    setQuery("");
    setOpen(false);
    setHighlight(-1);
    onChange(key);
  };

  // 锚定到输入框下方（空间不足翻转到上方）；监听滚动/缩放保持贴边
  const measure = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 8;
    const above = rect.top - 8;
    const flipUp = below < 220 && above > below;
    setPos({
      x: rect.left,
      width: rect.width,
      down: flipUp ? null : rect.bottom + 4,
      up: flipUp ? window.innerHeight - rect.top + 4 : null,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, measure]);

  // 过滤（label/key 均可匹配）+ 最近使用置顶（去重，避免同 key 出现两处）
  const q = query.trim().toLowerCase();
  const visible = useMemo(() => {
    const matched = FIELD_OPTIONS.filter((o) => !q || o.label.toLowerCase().includes(q) || o.key.toLowerCase().includes(q));
    const showRecent = !q && recent.length > 0;
    const recentSet = new Set(showRecent ? recent : []);
    const recents = matched.filter((o) => recentSet.has(o.key));
    const groups = new Map<string, FieldOption[]>();
    for (const group of FIELD_GROUPS) {
      const items = matched.filter((o) => o.group === group && !recentSet.has(o.key));
      if (items.length > 0) groups.set(group, items);
    }
    return { showRecent, recents, groups, rest: Array.from(groups.values()).flat(), hasMatch: matched.length > 0 };
  }, [q, recent]);
  const flat = visible.showRecent ? [...visible.recents, ...visible.rest] : visible.rest;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      if (flat.length > 0) setHighlight((h) => Math.min(h + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length > 0) setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && highlight >= 0 && flat[highlight]) choose(flat[highlight].key);
      else setOpen(false);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setQuery("");
      setOpen(false);
    }
  };

  const listStyle: React.CSSProperties | undefined = pos
    ? { position: "fixed", left: pos.x, width: Math.max(pos.width, 200), maxHeight: 240, ...(pos.down !== null ? { top: pos.down } : { bottom: pos.up ?? 0 }) }
    : undefined;

  let idx = -1;
  const renderOption = (o: FieldOption) => {
    const i = ++idx;
    const sel = o.key === value;
    return (
      <button
        key={o.key}
        type="button"
        role="option"
        aria-selected={sel}
        onMouseEnter={() => setHighlight(i)}
        onClick={() => choose(o.key)}
        className={`flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs transition-colors ${i === highlight ? "bg-[var(--color-surface-hover)] text-[var(--color-text)]" : "text-[var(--color-text)]"}`}
      >
        <span className="min-w-0 flex-1 truncate">{o.label}</span>
        {sel && <span aria-hidden="true" className="shrink-0 text-[var(--color-status)]">✓</span>}
      </button>
    );
  };

  return (
    <div ref={rootRef} className="relative min-w-0">
      <input
        ref={inputRef}
        role="combobox"
        aria-label="条件字段"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        autoComplete="off"
        spellCheck={false}
        value={open ? query : labelOf(value)}
        placeholder={open ? "输入以过滤…" : ""}
        onChange={(e) => {
          setQuery(e.target.value);
          if (!open) setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className={`${controlClass} w-full`}
      />
      {open && portalHost.current && (
        createPortal(
          <div
            id={listId}
            role="listbox"
            aria-label="条件字段列表"
            className="z-50 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] py-1 shadow-lg"
            style={listStyle}
          >
            {visible.showRecent && (
              <div role="group" aria-label="最近使用">
                <div className="px-3 pt-1 pb-0.5 text-[10px] font-medium text-[var(--color-text-tertiary)]">最近使用</div>
                {visible.recents.map(renderOption)}
              </div>
            )}
            {Array.from(visible.groups.entries()).map(([group, items]) => (
              <div key={group} role="group" aria-label={group}>
                <div className="px-3 pt-1 pb-0.5 text-[10px] font-medium text-[var(--color-text-tertiary)]">{group}</div>
                {items.map(renderOption)}
              </div>
            ))}
            {!visible.hasMatch && <div className="px-3 py-2 text-xs text-[var(--color-text-tertiary)]">没有匹配的字段</div>}
          </div>,
          portalHost.current,
        )
      )}
    </div>
  );
}

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
    // U-2：chip + 可搜索面板（弃用 <select multiple>——桌面端必须 Ctrl+点击选不中多个）。
    // §9.8：已有非空 tagId 时，两边都找不到 → 显示「标签 #id」，绝不退回「选择标签」
    const options = [...allTagOptions];
    for (const id of cond.tagIds) {
      if (!options.some((t) => t.id === id)) {
        options.push({ id, name: `标签 #${id}`, facet: cond.facetKey || "custom", aliases: [] });
      }
    }
    const data: TagCondData = {
      facetKey: cond.facetKey,
      tagIds: cond.tagIds,
      mode: (cond.type === "tag" ? cond.mode : "any") ?? "any",
      includeDescendants: cond.type === "tag" ? cond.includeDescendants : false,
    };
    return (
      <div className="flex min-w-0 flex-col items-stretch gap-1 self-start">
        <TagValueCell
          isExclude={cond.type === "excludeTag"}
          data={data}
          options={options}
          onChange={(next) => onChange((cond.type === "tag"
            ? { ...cond, facetKey: next.facetKey, tagIds: next.tagIds, mode: next.mode, includeDescendants: next.includeDescendants }
            : { ...cond, facetKey: next.facetKey, tagIds: next.tagIds }) as LeafCond)}
        />
      </div>
    );
  }
  return <MetadataValue filter={cond.filter} onChange={(filter) => onChange({ ...cond, filter })} />;
}

/** U-2：标签值单元格 —— 已选 chip（可单个移除）+ 「＋」按钮展开可搜索面板（按分面分组勾选）。
 *  面板内搜索框带匹配模式下拉（精确/别名/前缀/包含/纠错，默认别名）；面板展开为行内流式，
 *  抬高行高即可完整显示，不会被外层 overflow 容器裁切。 */
function TagValueCell({ isExclude, data, options, onChange }: { isExclude: boolean; data: TagCondData; options: FlatTag[]; onChange: (next: TagCondData) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [match, setMatch] = useState<TermMatchKey>(DEFAULT_TERM_MATCH);
  const selected = new Set(data.tagIds);
  const byId = new Map(options.map((t) => [t.id, t]));
  const byFacet = new Map<string, FlatTag[]>();
  for (const t of options) {
    if (!tagMatch(t, q, match)) continue;
    const list = byFacet.get(t.facet) ?? [];
    list.push(t);
    byFacet.set(t.facet, list);
  }
  const toggle = (id: number) => {
    const nextIds = selected.has(id) ? data.tagIds.filter((x) => x !== id) : [...data.tagIds, id];
    const facets = new Set(nextIds.map((x) => byId.get(x)?.facet).filter(Boolean) as string[]);
    onChange({ ...data, tagIds: nextIds, facetKey: nextIds.length > 0 ? [...facets][0] ?? data.facetKey : data.facetKey });
  };
  return (
    <div className="flex min-w-0 flex-col items-stretch gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {data.tagIds.map((id) => {
          const tag = byId.get(id);
          const name = tag?.name ?? `标签 #${id}`;
          return (
            <span key={id} className="inline-flex h-6 max-w-full items-center gap-0.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] pr-0.5 pl-2 text-[11px] text-[var(--color-text)]">
              <span className="truncate">{name}</span>
              <button type="button" aria-label={`移除 ${name}`} title={`移除 ${name}`} onClick={() => toggle(id)} className="flex size-5 shrink-0 items-center justify-center rounded-full text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]">×</button>
            </span>
          );
        })}
        <button type="button" aria-expanded={open} aria-label="选择标签" onClick={() => setOpen((o) => !o)} className="inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-[var(--color-border-strong)] px-2 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]">＋ {data.tagIds.length > 0 ? "添加" : "选择标签"}</button>
      </div>
      {!isExclude && (
        <select aria-label="标签范围" value={data.mode === "all" ? "all" : data.includeDescendants ? "desc" : "self"} onChange={(e) => { const v = e.target.value; onChange(v === "all" ? { ...data, mode: "all", includeDescendants: false } : { ...data, mode: "any", includeDescendants: v === "desc" }); }} className={`${controlClass} w-full`}><option value="desc">含子标签</option><option value="self">仅当前</option><option value="all">同时满足</option></select>
      )}
      {open && (
        <div className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)]">
          <div className="flex items-center gap-1.5 border-b border-[var(--color-border)] p-1.5">
            <input aria-label="搜索标签" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索标签…" className="ui-control h-7 min-w-0 flex-1 px-2 text-xs" />
            <select aria-label="匹配模式" value={match} onChange={(e) => setMatch(e.target.value as TermMatchKey)} className={`${controlClass} w-[72px] shrink-0`}>{TERM_MATCH_KEYS.map((k) => <option key={k} value={k}>{TERM_MATCH_LABELS[k]}</option>)}</select>
          </div>
          <div className="max-h-48 overflow-y-auto py-1">
            {byFacet.size === 0 && <div className="px-3 py-2 text-xs text-[var(--color-text-tertiary)]">没有匹配的标签</div>}
            {Array.from(byFacet.entries()).map(([facet, tags]) => (
              <div key={facet}>
                <div className="px-3 pt-1 pb-0.5 text-[10px] font-medium text-[var(--color-text-tertiary)]">{facet}</div>
                {tags.map((t) => { const on = selected.has(t.id); return (
                  <button key={t.id} type="button" role="checkbox" aria-checked={on} aria-label={t.name} onClick={() => toggle(t.id)} className={`flex w-full items-center gap-1.5 px-3 py-1 text-left text-xs ${on ? "text-[var(--color-text)]" : "text-[var(--color-text-secondary)]"}`}>
                    <span aria-hidden="true" className="w-3 shrink-0 text-[var(--color-status)]">{on ? "✓" : ""}</span>
                    <span className="truncate">{t.name}</span>
                  </button>
                ); })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
function MetadataValue({ filter, onChange }: { filter: MetadataFilter; onChange: (filter: MetadataFilter) => void }) {
  // U-3：前三色走色块选择器（单选 eq + 占比阈值 / 多选 in）
  if (filter.key === "palette_top3") return <PaletteValue filter={filter} onChange={onChange} />;
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
// U-3：前三色色块 —— 12 hue（colorName.ts HUE_NAMES 端点中值，与 palette_bucket 桶序一致）+ 黑/灰/白
const PALETTE_SWATCHES: { name: string; color: string }[] = [
  { name: "红", color: "hsl(7.5, 90%, 55%)" },
  { name: "橙", color: "hsl(30, 90%, 55%)" },
  { name: "黄", color: "hsl(57.5, 90%, 55%)" },
  { name: "黄绿", color: "hsl(80, 90%, 45%)" },
  { name: "绿", color: "hsl(122.5, 90%, 45%)" },
  { name: "青绿", color: "hsl(170, 90%, 45%)" },
  { name: "青", color: "hsl(205, 90%, 45%)" },
  { name: "天蓝", color: "hsl(240, 90%, 60%)" },
  { name: "蓝", color: "hsl(275, 90%, 55%)" },
  { name: "紫", color: "hsl(307.5, 90%, 55%)" },
  { name: "品红", color: "hsl(332.5, 90%, 55%)" },
  { name: "玫红", color: "hsl(352.5, 90%, 55%)" },
  { name: "黑", color: "hsl(0, 0%, 12%)" },
  { name: "灰", color: "hsl(0, 0%, 55%)" },
  { name: "白", color: "hsl(0, 0%, 98%)" },
];
function paletteColorsFromFilter(filter: MetadataFilter): string[] {
  if (filter.op === "in") return (filter.values ?? []).filter((v): v is string => typeof v === "string");
  const v = filter.value;
  if (typeof v === "string") return [v];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
/** U-3：色块选择器值单元格 —— 单选色 → eq（带占比阈值 min 0..1）；多选色 → in values。
 *  色相/饱和度/明度的高级数值输入仍保留在字段下拉「颜色」组（dominant_*）。 */
function PaletteValue({ filter, onChange }: { filter: MetadataFilter; onChange: (f: MetadataFilter) => void }) {
  const colors = paletteColorsFromFilter(filter);
  const single = colors.length === 1;
  const numMin = typeof filter.min === "number" ? filter.min : typeof filter.min === "string" ? Number(filter.min) : NaN;
  const pct = single && Number.isFinite(numMin) ? Math.round(numMin * 100) : 0;
  const commit = (next: string[], ratioPct: number) => {
    if (next.length === 0) {
      onChange({ key: filter.key, op: "eq", value: undefined });
      return;
    }
    if (next.length === 1) {
      onChange(ratioPct > 0 ? { key: filter.key, op: "eq", value: next[0], min: ratioPct / 100 } : { key: filter.key, op: "eq", value: next[0] });
      return;
    }
    onChange({ key: filter.key, op: "in", values: next });
  };
  return (
    <div className="flex min-w-0 flex-col items-start gap-1 self-start">
      <div className="flex flex-wrap items-center gap-1">
        {PALETTE_SWATCHES.map((sw) => {
          const on = colors.includes(sw.name);
          return (
            <button
              key={sw.name}
              type="button"
              aria-label={sw.name}
              aria-pressed={on}
              title={sw.name}
              onClick={() => commit(on ? colors.filter((c) => c !== sw.name) : [...colors, sw.name], on ? 0 : pct)}
              className={`size-6 shrink-0 rounded-full border transition-transform ${on ? "scale-110 ring-2 ring-[var(--color-status)]" : "border-[var(--color-border-strong)]"}`}
              style={{ backgroundColor: sw.color }}
            />
          );
        })}
      </div>
      {single && (
        <div className="flex w-full items-center gap-2 text-[11px] text-[var(--color-text-secondary)]">
          <input aria-label="占比阈值" type="range" min={0} max={100} step={5} value={pct} onChange={(e) => commit(colors, Number(e.target.value))} className="h-1 min-w-0 flex-1 accent-[var(--color-accent)]" />
          <span className="shrink-0 whitespace-nowrap">{pct === 0 ? "不限占比" : `占 ${pct}% 以上`}</span>
        </div>
      )}
    </div>
  );
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
