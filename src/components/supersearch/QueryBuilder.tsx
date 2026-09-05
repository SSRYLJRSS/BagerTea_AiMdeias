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
import { useMetadataStore } from "@/stores/metadataStore";
import { useNumericDomainStore } from "@/stores/numericDomainStore";
import type { AssetType, MetadataFacetItem, MetadataFilter, MetadataFilterKey, MetadataOp, NumericDomain } from "@/types/asset";
import type { LeafCond, QueryExpr } from "@/types/queryExpr";
import type { PlanDiagnostics, SearchPlanV3, ShouldClause } from "@/types/superSearch";
import { diagnoseSearchPlan } from "@/api/superSearch";
import { mergeQueryExpr, normalizeExpr, serializeExpr } from "@/utils/queryExprUtils";
import {
  DATE_SHORTCUT_OPTIONS,
  shortcutEndMs,
  shortcutStartMs,
  toIsoDateString,
  type DateShortcutKind,
} from "@/utils/dateShortcuts";

type FieldKey = "search" | "tag" | "excludeTag" | "assetType" | "untagged" | "facetHasAny" | "facetMissing" | MetadataFilterKey | `facet:${string}`;
/** V24（Phase 7-8）：数值分面字段 key 前缀（domain key = facet:<facet_key>） */
const FACET_FIELD_PREFIX = "facet:";
type GroupMode = "and" | "or";
type FlatTag = { id: number; name: string; facet: string; aliases: string[] };
type TagCondData = { facetKey: string; tagIds: number[]; mode: "any" | "all"; includeDescendants: boolean; termQuery: string | null; termMatch: TermMatchKey };
type Row = { id: string; negated: boolean; cond: LeafCond };
type FieldOption = { key: FieldKey; label: string; group: "关键词" | "标签" | "素材" | "颜色" | "定位" | "时间" | "拍摄设备" | "视频" | "数值分面"; kind?: "number" | "text" | "date" | "size" | "duration" | "resolution"; ops?: MetadataOp[] };

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
  // Phase 4（§5.1 / 4-5）：rating / favorite / folder 从后端白名单补进条件行。
  // rating 是 Stars domain（ValueInput eq → 星选）；favorite/folder 走枚举（命中数下拉/`属于任一` chip）。
  { key: "rating", label: "评级", group: "素材", kind: "number", ops: NUMERIC_OPS },
  { key: "favorite", label: "收藏", group: "素材", kind: "text", ops: ENUM_OPS },
  { key: "folder", label: "所在文件夹", group: "素材", kind: "text", ops: ENUM_OPS },
];
const FIELD_GROUPS = ["关键词", "标签", "素材", "颜色", "定位", "时间", "拍摄设备", "视频", "数值分面"] as const;
const RECENT_FIELDS_KEY = "qb:recent-fields";
const MAX_RECENT_FIELDS = 5;
/** U-1：最近使用字段持久化（localStorage 最多 5 个，最新在前）；读取容错返回 [] */
function readRecentFields(): FieldKey[] {
  try {
    const raw = localStorage.getItem(RECENT_FIELDS_KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((k): k is FieldKey => typeof k === "string" && (FIELD_OPTIONS.some((o) => o.key === k) || k.startsWith(FACET_FIELD_PREFIX))).slice(0, MAX_RECENT_FIELDS);
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
  const { expr, setExpr, clearConditions, resolvedTags, plan, planRevision, setPlanShould, setPlanMustNot, moveConditionBetweenZones } = useSuperSearchStore(
    useShallow((s) => ({
      expr: s.expr, setExpr: s.setExpr, clearConditions: s.clearConditions,
      resolvedTags: s.resolvedTags, plan: s.plan, planRevision: s.planRevision,
      setPlanShould: s.setPlanShould, setPlanMustNot: s.setPlanMustNot,
      moveConditionBetweenZones: s.moveConditionBetweenZones,
    })),
  );
  const tagTree = useTagStore((s) => s.tree); const tagsLoading = useTagStore((s) => s.loading);
  const [mode, setMode] = useState<GroupMode>("and"); const [rows, setRows] = useState<Row[]>([]);
  const [formulaWarning, setFormulaWarning] = useState<string | null>(null);
  // U-4：嵌套树的只读树形查看默认收起，可展开
  const [treeOpen, setTreeOpen] = useState(false);
  const lastLocalSignature = useRef<string | null>(null);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tagRefreshStarted = useRef(false);
  useEffect(() => {
    // 首次加载空树时只拉取一次：refresh 会把 loading 翻转两次（true→false），
    // 若把 tagsLoading 也纳入重触发条件，空库（listTags 返回空）会无限「refresh→loading 翻转→再 refresh」循环。
    if (tagRefreshStarted.current) return;
    if (tagTree.length === 0 && !tagsLoading) {
      tagRefreshStarted.current = true;
      void useTagStore.getState().refresh();
    }
  }, [tagTree.length, tagsLoading]);
  // Phase 4（§5.3）：NumericDomain / 枚举命中数都是消费型数据 —— 首次挂载拉一次，失败静默。
  const { domains: numericDomains, loaded: domainsLoaded, loading: domainsLoading } = useNumericDomainStore(useShallow((s) => ({ domains: s.domains, loaded: s.loaded, loading: s.loading })));
  const { facets: metadataFacets, loaded: metaLoaded, loading: metaLoading } = useMetadataStore(useShallow((s) => ({ facets: s.facets, loaded: s.loaded, loading: s.loading })));
  const dataRefreshStarted = useRef(false);
  useEffect(() => {
    if (dataRefreshStarted.current) return;
    if (numericDomains.length === 0 && !domainsLoading && !domainsLoaded) {
      dataRefreshStarted.current = true;
      void useNumericDomainStore.getState().refresh();
    }
  }, [numericDomains.length, domainsLoading, domainsLoaded]);
  const metaRefreshStarted = useRef(false);
  useEffect(() => {
    if (metaRefreshStarted.current) return;
    if (metadataFacets.length === 0 && !metaLoading && !metaLoaded) {
      metaRefreshStarted.current = true;
      void useMetadataStore.getState().refresh();
    }
  }, [metadataFacets.length, metaLoading, metaLoaded]);
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
  // Phase 4（§5.3）：允许 between 倒置的 key 集合（= domain.circular，如 dominant_hue）
  const circularKeys = useMemo(() => new Set(numericDomains.filter((d) => d.circular).map((d) => d.key)), [numericDomains]);
  const commit = (nextRows: Row[], nextMode = mode) => {
    if (formulaWarning) {
      // §9.6.1：嵌套模式下只允许「新条件与整棵现有 expr 以 AND 合并」
      const leafExpr = rowsToExpr(nextRows, nextMode, circularKeys);
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
    const nextExpr = rowsToExpr(nextRows, nextMode, circularKeys);
    const signature = nextExpr ? serializeExpr(nextExpr) : "";
    setRows(nextRows); setMode(nextMode); setFormulaWarning(null);
    lastLocalSignature.current = signature;
    setExpr(nextExpr);
  };
  const addRow = () => commit([...rows, { id: uid(), negated: false, cond: makeCond("tag", allTagOptions) }]);
  const updateRow = (id: string, patch: Partial<Row>) => commit(rows.map((row) => row.id === id ? { ...row, ...patch } : row));
  const clearAll = () => { if (commitTimer.current) clearTimeout(commitTimer.current); lastLocalSignature.current = ""; setRows([]); setFormulaWarning(null); clearConditions(); };
  // §3.4：排除区（plan.mustNot）—— 命中任一条即排除，天然 OR 平铺（不支持嵌套组）；
  // 行内不提供「不是」下拉（排除由区承担，避免双重否定）。存储走 setPlanMustNot。
  const mustNotRoot = plan?.mustNot ?? null;
  const mustNotSig = mustNotRoot ? serializeExpr(mustNotRoot) : "";
  const [exRows, setExRows] = useState<Row[]>([]);
  const [exUnsupported, setExUnsupported] = useState(false);
  const lastExSignature = useRef<string | null>(null);
  useEffect(() => {
    if (mustNotSig === lastExSignature.current) {
      lastExSignature.current = null;
      return;
    }
    if (!mustNotRoot) {
      setExRows([]);
      setExUnsupported(false);
      return;
    }
    const model = exprToRows(mustNotRoot);
    // 只接受「单叶 / OR(叶)」且无 NOT 子树；历史遗留的嵌套 mustNot 只读展示，不提供行编辑
    if (!model.unsupported && model.rows.every((r) => !r.negated)) {
      setExUnsupported(false);
      setExRows(model.rows);
    } else {
      setExUnsupported(true);
      setExRows([]);
    }
  }, [mustNotSig]);
  const commitMustNot = (nextRows: Row[]) => {
    const nextExpr = rowsToExpr(nextRows, "or", circularKeys);
    const signature = nextExpr ? serializeExpr(nextExpr) : "";
    setExRows(nextRows);
    lastExSignature.current = signature;
    setPlanMustNot(nextExpr);
  };
  const addMustNotRow = () => commitMustNot([...exRows, { id: uid(), negated: false, cond: makeCond("tag", allTagOptions) }]);
  const updateMustNotRow = (id: string, patch: Partial<Row>) => commitMustNot(exRows.map((row) => row.id === id ? { ...row, ...patch, negated: false } : row));
  const removeMustNotRow = (id: string) => commitMustNot(exRows.filter((item) => item.id !== id));
  const mustNotLeafCount = mustNotRoot ? countLeafNodes(mustNotRoot) : 0;
  // U-6/§4.5：四指标诊断（diagnose_search_plan_cmd → PlanDiagnostics）——
  // 叶子带 zone（filter/mustNot），加分项带 index，warnings 与列表同批。
  const [diag, setDiag] = useState<PlanDiagnostics | null>(null);
  const exprKey = expr ? serializeExpr(expr) : "";
  useEffect(() => {
    if (formulaWarning === "nested" || (!expr && !mustNotRoot && plan?.should.length === 0)) {
      setDiag(null);
      return;
    }
    // 无 plan（纯手动条件）时用 expr 合成最小 plan 供后端诊断（filter=expr，加分空）
    const diagPlan: SearchPlanV3 = plan ?? {
      planSchemaVersion: 3,
      normalizationVersion: 1,
      compilerVersion: 1,
      filter: expr ?? null,
      mustNot: null,
      should: [],
      minimumShouldMatch: 0,
      retrievers: { retrievers: [] },
      ranking: { type: "field", key: "created_at", dir: "desc" },
    };
    const revisionAtRequest = planRevision;
    let alive = true;
    setDiag(null);
    diagnoseSearchPlan(diagPlan, revisionAtRequest)
      .then((d) => {
        if (!alive) return;
        // §3.7 不变式 9：诊断返回时代次过期 → 整批丢弃（旧诊断会指着新条件的位置）
        if (d.leaves.some((l) => l.planRevision !== revisionAtRequest)) return;
        if (d.should.some((s) => s.planRevision !== revisionAtRequest)) return;
        setDiag(d);
      })
      .catch(() => { if (alive) setDiag(null); }); // 诊断只读且可失败：失败静默，不影响条件编辑
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exprKey, plan ? `${plan.minimumShouldMatch}#${plan.should.length}#${plan.mustNot ? serializeExpr(plan.mustNot) : ""}` : "manual", formulaWarning, planRevision, mustNotSig]);
  // U-5：加分项（should）只读区所需数据 —— plan.should 为 store 单源；加分项是非嵌套叶子（ShouldClause.cond）
  const shouldList = plan?.should ?? [];
  const shouldMin = plan?.minimumShouldMatch ?? 0;
  const setShould = (next: typeof shouldList, min?: number) => setPlanShould(next, min ?? Math.min(shouldMin, next.length));
  const patchShould = (index: number, next: ShouldClause) => setShould(shouldList.map((x, i) => (i === index ? next : x)), shouldMin);

  const hasAnyConditions = rows.length > 0 || exRows.length > 0 || shouldList.length > 0 || Boolean(mustNotRoot) || Boolean(formulaWarning);
  const [shouldAdvanced, setShouldAdvanced] = useState(false);
  return (
    <section className="overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)]" aria-label="条件公式">
      <div className="flex min-h-10 items-center gap-2 border-b border-[var(--color-border)] px-3 py-2"><span className="text-xs font-semibold text-[var(--color-text)]">筛选条件</span><span className="text-[11px] text-[var(--color-text-tertiary)]">AI 生成后可继续修改</span>{hasAnyConditions && <button type="button" onClick={clearAll} className="ml-auto text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text)]">清除全部</button>}</div>
      <div className="px-3 py-2.5">
        {/* ═══ 必须满足区（plan.filter）═══ */}
        <div id="qb-zone-filter" data-zone="filter">
          <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--color-text-secondary)]">
            <span className="text-xs font-semibold text-[var(--color-text)]">必须满足</span>
            <span className="text-[11px] text-[var(--color-text-tertiary)]">全部满足才显示</span>
            <span className="ml-auto flex items-center gap-1">
              <span>以下</span>
              <select aria-label="条件连接方式" value={mode} disabled={Boolean(formulaWarning)} onChange={(e) => commit(rows, e.target.value as GroupMode)} className={`${controlClass} w-20 font-medium text-[var(--color-text)]`}><option value="and">全部条件</option><option value="or">任一条件</option></select>
            </span>
          </div>
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
          {rows.length === 0 ? <button id="qb-must-add" type="button" onClick={addRow} className="flex h-10 w-full items-center justify-center border border-dashed border-[var(--color-border)] text-xs text-[var(--color-text-secondary)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]">+ 添加第一个条件</button> : <div className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">{rows.map((row, index) => { const rowDiag = diag && expr ? rowDiagFor(diag.leaves, expr, "filter", index) : undefined; return (
            <div key={row.id}>
              <ConditionRow row={row} prefix={index === 0 ? "当" : mode === "and" ? "并且" : "或者"} allTagOptions={allTagOptions} zone="filter" onMove={(t) => moveConditionBetweenZones("filter", t, [index])} onChange={(patch) => updateRow(row.id, patch)} onRemove={() => commit(rows.filter((item) => item.id !== row.id))} />
              {rowDiag && <LeafDiagNote diag={rowDiag} />}
            </div>
          ); })}</div>}
          {rows.length > 0 && <button id="qb-must-add" type="button" onClick={addRow} className="mt-2 h-8 px-1 text-xs font-medium text-[var(--color-status)] hover:opacity-80">+ 添加条件</button>}
        </div>
        {/* ═══ 优先满足区（plan.should）═══ */}
        <div id="qb-zone-should" data-zone="should" className="mt-3 border-t border-[var(--color-border)] pt-2.5">
          <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xs font-semibold text-[var(--color-text)]">优先满足</span>
            <span className="text-[11px] text-[var(--color-text-tertiary)]">满足越多越靠前 · 不满足不淘汰</span>
          </div>
          {shouldList.map((sc, i) => {
            const field = fieldFromCond(sc.cond);
            const sDiag = diag && diag.should[i];
            return (
              <div key={`should-${i}`} className="mb-1.5">
                <div className="grid grid-cols-[40px_minmax(110px,0.8fr)_minmax(92px,0.55fr)_minmax(150px,1.5fr)_64px_28px_28px] items-center gap-2 max-[900px]:grid-cols-[36px_minmax(100px,1fr)_minmax(88px,1fr)_minmax(130px,1.4fr)_60px_26px_26px]">
                  <span className="pl-1 text-[11px] text-[var(--color-text-tertiary)]">{i === 0 ? "当" : "或"}</span>
                  <FieldSelect value={field} onChange={(next) => patchShould(i, { ...sc, cond: makeCond(next, allTagOptions) })} />
                  <ConditionOperator cond={sc.cond} negated={false} onChange={(p) => { if (p.cond) patchShould(i, { ...sc, cond: p.cond }); }} />
                  <ConditionValue cond={sc.cond} allTagOptions={allTagOptions} onChange={(cond) => patchShould(i, { ...sc, cond })} />
                  <select aria-label="加分权重" value={String(sc.weight)} onChange={(e) => patchShould(i, { ...sc, weight: Number(e.target.value) })} className={`${controlClass} w-full`}>
                    <option value="0.5">轻微偏好</option><option value="1">一般偏好</option><option value="2">强烈偏好</option>
                  </select>
                  <MoveMenu zone="should" onMove={(t) => moveConditionBetweenZones("should", t, i)} />
                  <button type="button" aria-label={`移除加分项 ${i + 1}`} onClick={() => setShould(shouldList.filter((_, j) => j !== i))} className="flex size-7 items-center justify-center rounded text-base text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-danger)]">×</button>
                </div>
                {/* §3.5：evidence 原文回显（AI 判断可逐条改判的草稿） */}
                {sc.evidence ? (
                  <div className="pr-1 text-right text-[10px] text-[var(--color-text-tertiary)]">「{sc.evidence}」</div>
                ) : null}
                {sDiag && (
                  <div className="pr-1 text-right text-[10px] text-[var(--color-text-tertiary)]">命中 {sDiag.hitCount}/{sDiag.totalCount}</div>
                )}
              </div>
            );
          })}
          {shouldList.length === 0 && <p className="mb-1 text-[11px] text-[var(--color-text-tertiary)]">把「最好有 / 优先」倾向加在这里：只参与排序，不淘汰结果。</p>}
          <button type="button" onClick={() => setShould([...shouldList, { cond: makeCond("tag", allTagOptions), weight: 1, label: "" }])} className="mt-1 h-7 px-1 text-xs font-medium text-[var(--color-status)] hover:opacity-80">＋ 添加优先条件</button>
          {/* §3.4：「至少满足 N 项」移入〔高级设置〕折叠区（缩小结果集的开关，不与标题旁文案混淆） */}
          {shouldList.length > 0 && (
            <div className="mt-2 border-t border-dashed border-[var(--color-border)] pt-1.5">
              <button type="button" aria-expanded={shouldAdvanced} onClick={() => setShouldAdvanced((o) => !o)} className="flex items-center gap-1 text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]">
                <span aria-hidden="true" className="text-[9px]">{shouldAdvanced ? "▾" : "▸"}</span>
                高级设置
              </button>
              {shouldAdvanced && (
                <div className="mt-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-[11px] text-[var(--color-text-secondary)]">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span>至少满足</span>
                    <select aria-label="至少满足" value={shouldMin} onChange={(e) => setShould(shouldList, Number(e.target.value))} className={`${controlClass} w-16`}>
                      {Array.from({ length: shouldList.length + 1 }, (_, i) => <option key={i} value={i}>{i === 0 ? "0（不限）" : i === shouldList.length ? `${i}（全部）` : i}</option>)}
                    </select>
                    <span>项才显示</span>
                  </div>
                  <p className="mt-1 leading-4 text-[var(--color-text-tertiary)]">0 = 不限（全部保留，只调整顺序）</p>
                  <p className="leading-4 text-[var(--color-text-tertiary)]">N = 至少命中 N 条优先条件的素材才会出现</p>
                </div>
              )}
            </div>
          )}
        </div>
        {/* ═══ 排除区（plan.mustNot）═══ */}
        <div id="qb-zone-mustnot" data-zone="mustNot" className="mt-3 border-t border-[var(--color-border)] pt-2.5">
          <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xs font-semibold text-[var(--color-text)]">排除</span>
            <span className="text-[11px] text-[var(--color-text-tertiary)]">命中任一条就不显示</span>
          </div>
          {exUnsupported && mustNotRoot ? (
            <div className="mb-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[11px] leading-4 text-[var(--color-text-tertiary)]">
              排除条件为只读的复杂表达式（{mustNotLeafCount} 项）：不支持在此直接编辑，可在上方条件条中逐项移除后重建。
            </div>
          ) : exRows.length === 0 ? (
            <button type="button" onClick={addMustNotRow} className="flex h-10 w-full items-center justify-center border border-dashed border-[var(--color-border)] text-xs text-[var(--color-text-secondary)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]">+ 添加第一个排除条件</button>
          ) : (
            <div className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">{exRows.map((row, index) => { const rowDiag = diag && mustNotRoot ? rowDiagFor(diag.leaves, mustNotRoot, "mustNot", index) : undefined; return (
              <div key={row.id}>
                <ConditionRow row={row} prefix={index === 0 ? "当" : "或"} allTagOptions={allTagOptions} zone="mustNot" onMove={(t) => moveConditionBetweenZones("mustNot", t, [index])} onChange={(patch) => updateMustNotRow(row.id, patch)} onRemove={() => removeMustNotRow(row.id)} />
                {rowDiag && <LeafDiagNote diag={rowDiag} />}
              </div>
            ); })}</div>
          )}
          {exRows.length > 0 && !exUnsupported && <button type="button" onClick={addMustNotRow} className="mt-2 h-8 px-1 text-xs font-medium text-[var(--color-status)] hover:opacity-80">＋ 添加排除条件</button>}
        </div>
      </div>
    </section>
  );
}

/** U-6/§3.7-9：按行找该行指定区（filter/mustNot）的叶子诊断 —— 先按 zone 过滤再匹配 path，
 *  两区同下标的叶子不会互相误配。 */
function rowDiagFor(leaves: PlanDiagnostics["leaves"], root: QueryExpr, zone: "filter" | "mustNot", rowIdx: number) {
  const target = root.op === "leaf" ? [] : [rowIdx];
  return leaves.find((l) => l.zone === zone && l.path.length === target.length && target.every((v, i) => l.path[i] === v));
}

/** U-6：叶子诊断注记 —— delta>0 且 result=0 标红「把结果砍到 0」；否则显示 −delta；self_count=0 额外标注。 */
function LeafDiagNote({ diag }: { diag: PlanDiagnostics["leaves"][number] }) {
  const zeroing = diag.delta > 0 && diag.resultCount === 0;
  const parts: string[] = [];
  if (zeroing) parts.push("⚠ 这个条件把结果砍到 0");
  else if (diag.delta > 0) parts.push(`−${diag.delta}`);
  else if (diag.delta < 0) parts.push(`+${-diag.delta}`);
  if (diag.selfCount === 0) parts.push("这个条件单独就没有匹配项");
  if (parts.length === 0) return null;
  return (
    <div className={`px-1 pb-1 text-[10px] leading-4 ${zeroing ? "text-[var(--color-danger)]" : "text-[var(--color-text-tertiary)]"}`}>
      {parts.join(" · ")}
    </div>
  );
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
    case "facetNumber": {
      const domain = useNumericDomainStore.getState().domains.find((d) => d.key === `${FACET_FIELD_PREFIX}${cond.facetKey}`);
      const label = domain?.label ?? cond.facetKey;
      const opText: Record<string, string> = { eq: "=", gt: ">", gte: "≥", lt: "<", lte: "≤" };
      return cond.op === "between"
        ? `${label} ${cond.value}~${cond.maxValue ?? ""}`
        : `${label} ${opText[cond.op] ?? cond.op} ${cond.value}`;
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

/** §3.5/3-6：行尾「⋯ 更多」菜单 —— 条件在三区之间移动（AI 判断可逐条改判的草稿）。
 *  filter 行可移去 优先/排除；should 行可移去 必须/排除；mustNot 行可移去 必须/优先。 */
function MoveMenu({ zone, onMove }: { zone: "filter" | "should" | "mustNot"; onMove: (to: "filter" | "should" | "mustNot") => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const zoneLabels: Record<"filter" | "should" | "mustNot", string> = { filter: "必须满足", should: "优先满足", mustNot: "排除" };
  const targets = (zone === "filter" ? ["should", "mustNot"] : zone === "should" ? ["filter", "mustNot"] : ["filter", "should"]) as ("filter" | "should" | "mustNot")[];
  return (
    <span ref={ref} className="relative shrink-0">
      <button type="button" aria-label="更多操作" aria-expanded={open} title="移到其他区" onClick={() => setOpen((v) => !v)} className="flex size-7 items-center justify-center rounded text-xs text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]">⋯</button>
      {open && (
        <span className="absolute right-0 top-8 z-50 flex min-w-[8.5rem] flex-col overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] py-1 shadow-lg">
          {targets.map((t) => (
            <button key={t} type="button" aria-label={`移到${zoneLabels[t]}`} onClick={() => { setOpen(false); onMove(t); }} className="px-3 py-1.5 text-left text-xs text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]">
              移到「{zoneLabels[t]}」
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

function ConditionRow({ row, prefix, allTagOptions, zone, onMove, onChange, onRemove }: { row: Row; prefix: string; allTagOptions: FlatTag[]; zone: "filter" | "mustNot"; onMove: (to: "filter" | "should" | "mustNot") => void; onChange: (patch: Partial<Row>) => void; onRemove: () => void }) {
  const field = fieldFromCond(row.cond);
  return <div className="grid min-h-11 grid-cols-[48px_minmax(120px,0.8fr)_minmax(108px,0.65fr)_minmax(180px,1.6fr)_28px_32px] items-center gap-2 py-1.5 max-[800px]:grid-cols-[44px_minmax(105px,1fr)_minmax(96px,1fr)_minmax(130px,1.4fr)_26px_30px]"><span className="pl-1 text-[11px] text-[var(--color-text-tertiary)]">{prefix}</span><FieldSelect value={field} onChange={(next) => onChange({ cond: makeCond(next, allTagOptions), negated: false })} /><ConditionOperator cond={row.cond} negated={row.negated} onChange={onChange} /><ConditionValue cond={row.cond} allTagOptions={allTagOptions} onChange={(cond) => onChange({ cond })} /><MoveMenu zone={zone} onMove={onMove} /><button type="button" onClick={onRemove} className="flex size-7 items-center justify-center rounded text-base text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-danger)]" aria-label="删除条件" title="删除条件">×</button></div>;
}
function FieldSelect({ value, onChange, hideKeys = [] }: { value: FieldKey; onChange: (value: FieldKey) => void; hideKeys?: FieldKey[] }) {
  // V24（Phase 7-8）：数值分面字段 —— 从 NumericDomain 动态生成（key = facet:<facet_key>，label = 显示名）
  const facetDomains = useNumericDomainStore(useShallow((s) => s.domains.filter((d) => d.key.startsWith(FACET_FIELD_PREFIX))));
  const facetOptions = useMemo<FieldOption[]>(() => facetDomains.map((d) => ({
    key: d.key as FieldKey,
    label: d.label ?? d.key.slice(FACET_FIELD_PREFIX.length),
    group: "数值分面",
    kind: "number" as const,
    ops: NUMERIC_OPS,
  })), [facetDomains]);
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

  const labelOf = (key: FieldKey) => facetOptions.find((o) => o.key === key)?.label ?? FIELD_OPTIONS.find((o) => o.key === key)?.label ?? (key === "excludeTag" ? "排除标签（旧）" : key);

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
    // §3.8：字段表里的「排除标签」删除（并入排除区），新行不再能直接选 excludeTag；
    // 遗留 plan 中已有的 excludeTag 叶子仍可显示（labelOf 兜底），只是不能再新建。
    const options = [...FIELD_OPTIONS, ...facetOptions].filter((o) => o.key !== "excludeTag" && !hideKeys.includes(o.key));
    const matched = options.filter((o) => !q || o.label.toLowerCase().includes(q) || o.key.toLowerCase().includes(q));
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
  // §3.3/§3.8：行内不再有「是 / 不是」下拉 —— 否定语义统一由排除区承担，避免同一条件两种写法互相打架。
  // 遗留 plan 里的 NOT(leaf)（negated=true）仍以只读「不是」标注，防止被静默改义。
  if (cond.type === "facetHasAny" || cond.type === "facetMissing") return <span className="px-2 text-xs text-[var(--color-text-tertiary)]">{cond.type === "facetHasAny" ? "存在" : "缺失"}</span>;
  if (cond.type === "facetNumber") return <select aria-label="条件操作符" value={cond.op} onChange={(e) => onChange({ cond: changeFacetNumberOp(cond, e.target.value as FacetNumberOp) })} className={`${controlClass} w-full`}>{NUMERIC_OPS.map((op) => <option key={op} value={op}>{OP_LABELS[op]}</option>)}</select>;
  if (cond.type === "metadata") { const ops = FIELD_OPTIONS.find((item) => item.key === cond.filter.key)?.ops ?? NUMERIC_OPS; return <select aria-label="条件操作符" value={cond.filter.op} onChange={(e) => onChange({ cond: { ...cond, filter: changeMetadataOp(cond.filter, e.target.value as MetadataOp) } })} className={`${controlClass} w-full`}>{ops.map((op) => <option key={op} value={op}>{OP_LABELS[op]}</option>)}</select>; }
  return <span className="px-2 text-xs text-[var(--color-text-tertiary)]">{cond.type === "excludeTag" || negated ? "不是" : "是"}</span>;
}

function ConditionValue({ cond, allTagOptions, onChange }: { cond: LeafCond; allTagOptions: FlatTag[]; onChange: (cond: LeafCond) => void }) {
  if (cond.type === "facetNumber") {
    // V24（Phase 7-8）：数值分面值输入 —— 单值走 ValueInput（单位/预设/clamp 全来自 domain）；
    // between 两输入共用同一 domain（同一单位，§5.4）
    const domain = useNumericDomainStore((s) => s.domains).find((d) => d.key === `${FACET_FIELD_PREFIX}${cond.facetKey}`);
    if (cond.op === "between") {
      return (
        <span className="flex min-w-0 items-center gap-1">
          <ValueInput kind="number" domain={domain} value={cond.value} dateSide="start" onChange={(v) => onChange({ ...cond, value: typeof v === "number" ? v : Number(v ?? 0) })} />
          <span className="shrink-0 text-xs text-[var(--color-text-tertiary)]">至</span>
          <ValueInput kind="number" domain={domain} value={cond.maxValue ?? undefined} dateSide="end" onChange={(v) => onChange({ ...cond, maxValue: v === undefined ? null : typeof v === "number" ? v : Number(v) })} />
        </span>
      );
    }
    return <ValueInput kind="number" domain={domain} value={cond.value} dateSide={cond.op === "lte" || cond.op === "lt" ? "end" : "start"} onChange={(v) => onChange({ ...cond, value: typeof v === "number" ? v : Number(v ?? 0) })} />;
  }
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
      // S5 5-2：匹配方式持久在条件里（回显 AI termQuery），面板搜索词与模式双向绑定
      termQuery: cond.type === "tag" ? cond.termQuery ?? null : null,
      termMatch: cond.type === "tag" ? cond.termMatch ?? DEFAULT_TERM_MATCH : DEFAULT_TERM_MATCH,
    };
    return (
      <div className="flex min-w-0 flex-col items-stretch gap-1 self-start">
        <TagValueCell
          isExclude={cond.type === "excludeTag"}
          data={data}
          options={options}
          onChange={(next) => onChange((cond.type === "tag"
            ? { ...cond, facetKey: next.facetKey, tagIds: next.tagIds, mode: next.mode, includeDescendants: next.includeDescendants, termQuery: next.termQuery, termMatch: next.termMatch }
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
  // S5 5-2：匹配模式初始值来自条件（AI termQuery 回显），不再是本地临时状态
  const [match, setMatch] = useState<TermMatchKey>(data.termMatch ?? DEFAULT_TERM_MATCH);
  // 条件里已有按词查 → 面板搜索框预填（双向：改词即改条件）
  const [term, setTerm] = useState<string>(data.termQuery ?? "");
  useEffect(() => { setMatch(data.termMatch ?? DEFAULT_TERM_MATCH); }, [data.termMatch]);
  useEffect(() => { setTerm(data.termQuery ?? ""); }, [data.termQuery]);
  /** S5 5-2：按词查写进条件（词 + 模式）。词清空 → 移除 termQuery（回到纯 chip 语义）。 */
  const commitTerm = (raw: string, m: TermMatchKey) => {
    const t = raw.trim();
    setTerm(raw);
    onChange({ ...data, termQuery: t ? t : null, termMatch: m });
  };
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
      {!isExclude && (
        <div className="flex w-full items-center gap-1.5">
          <DraftInput
            ariaLabel="按词查"
            placeholder="按词查（可选，随条件保存）"
            displayValue={term}
            onCommit={(v) => commitTerm(v, match)}
            className={`${controlClass} min-w-0 flex-1`}
          />
          <select
            aria-label="词匹配方式"
            title="按词查的匹配方式（随条件保存，后端按此扩展标签）"
            value={match}
            onChange={(e) => { const m = e.target.value as TermMatchKey; setMatch(m); if (term.trim()) commitTerm(term, m); }}
            className={`${controlClass} w-[86px] shrink-0`}
          >
            {TERM_MATCH_KEYS.map((k) => <option key={k} value={k}>{TERM_MATCH_LABELS[k]}</option>)}
          </select>
          {term.trim() && (
            <span data-testid="term-query-chip" className="shrink-0 rounded-full bg-[var(--color-surface-hover)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
              词：{term.trim()}
            </span>
          )}
        </div>
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
  // Phase 4（§5.3）：数值字段的 min/max/step/后缀/预设/环形全部来自 NumericDomain（单一事实源）。
  const domain = useNumericDomainStore((s) => s.domains).find((d) => d.key === filter.key);
  const facetItems = useMetadataStore((s) => s.facets).find((f) => f.key === filter.key)?.items;
  const kind = FIELD_OPTIONS.find((item) => item.key === filter.key)?.kind ?? "number";
  if (filter.op === "between") {
    // Phase 4（§4-3）：范围一律成对 min/max；file_size 两侧共用同一个单位下拉（单位提升进 filter）。
    if (kind === "size") return <SizeBetweenValue filter={filter} onChange={onChange} />;
    const isCircular = domain?.circular ?? filter.key === "dominant_hue";
    const lo = typeof filter.min === "number" ? filter.min : typeof filter.min === "string" ? Number(filter.min) : NaN;
    const hi = typeof filter.max === "number" ? filter.max : typeof filter.max === "string" ? Number(filter.max) : NaN;
    const inverted = Number.isFinite(lo) && Number.isFinite(hi) && lo > hi;
    return (
      <div className="flex min-w-0 flex-col items-stretch gap-1">
        <div className="grid grid-cols-[minmax(0,1fr)_16px_minmax(0,1fr)] items-center gap-1">
          <ValueInput kind={kind} domain={domain} value={filter.min} dateSide="start" onChange={(min) => onChange({ ...filter, min })} />
          <span className="text-center text-[11px] text-[var(--color-text-tertiary)]">至</span>
          <ValueInput kind={kind} domain={domain} value={filter.max} dateSide="end" onChange={(max) => onChange({ ...filter, max })} />
        </div>
        {/* §5.3：区间倒置只有 circular（色相跨 0°）合法；其余给一句人话，不让倒置条件进库。 */}
        {inverted && !isCircular && <p className="text-[10px] text-[var(--color-danger)]">范围下限不能大于上限{filter.key === "dominant_hue" ? "（色相可跨 0°，其余字段不允许）" : ""}</p>}
        {inverted && isCircular && <p className="text-[10px] text-[var(--color-text-tertiary)]">色相跨 0° 区间（{lo}° 至 {hi}°）</p>}
      </div>
    );
  }
  // Phase 4（§5.5）：枚举字段（file_ext/camera/lens/folder…）的候选值带命中数下拉 —— 全库无条件计数。
  if (filter.op === "eq" && kind === "text" && facetItems && facetItems.length > 0) {
    return <EnumCountSelect key={filter.key} items={facetItems} value={typeof filter.value === "string" ? filter.value : ""} onChange={(v) => onChange({ ...filter, value: v })} />;
  }
  // Phase 4（§4-4）：`属于任一` 对可枚举字段改为 chip 多选（可搜索面板；命中数随选项展示）。
  if (filter.op === "in" && facetItems && facetItems.length > 0 && kind === "text") {
    const selected = new Set((filter.values ?? []).map(String));
    const toggle = (v: string) => {
      const next = selected.has(v) ? (filter.values ?? []).filter((x) => String(x) !== v) : [...(filter.values ?? []), v];
      onChange({ ...filter, values: next });
    };
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-1 self-start">
        {facetItems.slice(0, 200).map((item) => {
          const on = selected.has(item.value);
          return (
            <button key={item.value} type="button" role="checkbox" aria-checked={on} onClick={() => toggle(item.value)} className={`inline-flex h-6 max-w-full items-center gap-1 rounded-full border px-2 text-[11px] ${on ? "border-[var(--color-accent)] bg-[var(--color-accent)]/15 text-[var(--color-accent)]" : "border-[var(--color-border-strong)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)]"}`}>
              <span className="truncate">{item.label}</span>
              <span className="shrink-0 text-[10px] opacity-70">({item.count})</span>
            </button>
          );
        })}
      </div>
    );
  }
  // Phase 4（§5.4 Stars）：rating eq → 0–5 星选择器
  if (filter.op === "eq" && domain?.unit === "stars") {
    return <StarValue value={typeof filter.value === "number" ? filter.value : NaN} onChange={(v) => onChange({ ...filter, value: v })} />;
  }
  // Phase 4（§4-3）：file_size 单值输入的单位同样进 filter（换源/AI 合并后不丢单位）
  if (kind === "size" && filter.op !== "in") return <SizeValue filter={filter} onChange={onChange} />;
  // U-7 ②：日期快捷的语义与 op 绑定 —— gte/min 侧写期初，lte/max 侧写期末
  return <ValueInput kind={kind} domain={domain} rich value={filter.value} dateSide={filter.op === "lte" ? "end" : "start"} onChange={(value) => onChange({ ...filter, value })} />;
}
/** Phase 4（§5.5）：带命中数的枚举单值下拉 —— label 显示命中数，提交 value（与后端分面同键）。 */
function EnumCountSelect({ items, value, onChange }: { items: MetadataFacetItem[]; value: string; onChange: (v: string) => void }) {
  const known = items.some((i) => i.value === value);
  return (
    <select aria-label="条件值" value={known ? value : ""} onChange={(e) => onChange(e.target.value)} className={`${controlClass} w-full`}>
      <option value="" disabled>选择…</option>
      {!known && value ? <option value={value}>{value}</option> : null}
      {items.map((item) => (
        <option key={item.value} value={item.value}>{item.label}（{item.count}）</option>
      ))}
    </select>
  );
}
/** Phase 4（§5.4 Stars）：0–5 星选择器（0 = 未评级，点当前星可清回 0）。 */
function StarValue({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const v = Number.isFinite(value) ? Math.round(value) : 0;
  const set = (n: number) => onChange(n === v ? 0 : n);
  return (
    <div className="flex min-w-0 items-center gap-1 self-start">
      <span aria-hidden="true" className="text-[11px] text-[var(--color-text-tertiary)]">评级</span>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={v >= n}
          aria-label={`${n} 星`}
          title={`${n} 星`}
          onClick={() => set(n)}
          className={`text-base leading-none ${v >= n ? "text-[var(--color-warning)]" : "text-[var(--color-border-strong)] hover:text-[var(--color-text-secondary)]"}`}
        >
          ★
        </button>
      ))}
      <span className="ml-1 text-[11px] text-[var(--color-text-secondary)]">{v > 0 ? `${v} 星` : "未评级"}</span>
    </div>
  );
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
function ValueInput({ kind, value, onChange, dateSide, domain, rich }: { kind: NonNullable<FieldOption["kind"]>; value: string | number | undefined; dateSide?: "start" | "end"; domain?: NumericDomain; rich?: boolean; onChange: (value: string | number | undefined) => void }) {
  if (kind === "date") return <DateValue value={value} side={dateSide ?? "start"} onChange={onChange} />;
  if (kind === "text") return <DraftInput ariaLabel="条件值" placeholder="输入值" displayValue={String(value ?? "")} onCommit={(raw) => onChange(raw)} className={`${controlClass} w-full`} />;
  const factor = kind === "duration" ? 1000 : kind === "resolution" ? 1_000_000 : 1;
  const suffix = kind === "duration" ? "秒" : kind === "resolution" ? "MP" : domain?.unitLabel && kind === "number" ? domain.unitLabel : "";
  const isPlainNumber = kind === "number";
  const min = isPlainNumber ? (domain?.min ?? undefined) : undefined;
  const max = isPlainNumber ? (domain?.max ?? undefined) : undefined;
  const numStep = isPlainNumber ? (domain && domain.step > 0 ? String(domain.step) : "any") : "0.1";
  const commitNum = (raw: string) => {
    if (raw.trim() === "") { onChange(undefined); return; }
    const n = Number(raw) * factor;
    if (Number.isNaN(n)) { onChange(undefined); return; }
    // §5.3：输入 clamp 到 NumericDomain 的 min/max（circular 的跨 0° 语义只作用于 between，单值照 clamp）
    let clamped = n;
    if (isPlainNumber) {
      if (domain?.min != null && clamped < domain.min) clamped = domain.min;
      if (domain?.max != null && clamped > domain.max) clamped = domain.max;
    }
    onChange(clamped);
  };
  // Phase 4（§5.4 Percent）：sat/lum 用 0–100 滑块（探索量）—— 仅单值 op（eq/gt/lt…）；between 用成对数字输入
  if (isPlainNumber && domain?.unit === "percent" && rich) {
    const cur = typeof value === "number" && Number.isFinite(value) ? value : domain.min ?? 0;
    const pMin = domain.min ?? 0;
    const pMax = domain.max ?? 100;
    return (
      <div className="flex min-w-0 items-center gap-2">
        <input aria-label="条件值" type="range" min={pMin} max={pMax} step={domain.step > 0 ? domain.step : 1} value={cur} onChange={(e) => { const v = Number(e.target.value); onChange(v); }} className="h-1 min-w-0 flex-1 accent-[var(--color-accent)]" />
        <input aria-label="数值输入" type="number" step={numStep} min={min ?? undefined} max={max ?? undefined} value={cur} onChange={(e) => { const raw = e.target.value; if (raw === "") { onChange(undefined); return; } const n = Number(raw); if (!Number.isNaN(n)) { let c = n; if (domain?.min != null && c < domain.min) c = domain.min; if (domain?.max != null && c > domain.max) c = domain.max; onChange(c); } }} className={`${controlClass} w-16 shrink-0`} />
        {suffix && <span className="shrink-0 text-[10px] text-[var(--color-text-tertiary)]">{suffix}</span>}
      </div>
    );
  }
  const presetMatch = isPlainNumber && rich && domain && domain.presets.length > 0 && domain.unit !== "percent";
  return (
    <div className="flex min-w-0 flex-col items-stretch gap-1">
      {presetMatch && (
        <div className="flex flex-wrap gap-1">
          {domain!.presets.map(([label, pv]) => {
            const on = typeof value === "number" && value === pv;
            return (
              <button key={label} type="button" aria-pressed={on} onClick={() => onChange(pv)} className={`inline-flex h-5 items-center rounded-full border px-1.5 text-[10px] ${on ? "border-[var(--color-accent)] text-[var(--color-accent)]" : "border-[var(--color-border-strong)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)]"}`}>{label}</button>
            );
          })}
        </div>
      )}
      <DraftInput ariaLabel="条件值" type="number" step={numStep} min={min} max={max} placeholder="输入数值" suffix={suffix} displayValue={typeof value === "number" ? String(value / factor) : ""} onCommit={commitNum} className={`${controlClass} w-full ${suffix ? "pr-9" : ""}`} />
    </div>
  );
}
type SizeUnit = "KB" | "MB" | "GB";
const SIZE_FACTORS: Record<SizeUnit, number> = { KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024 };
const DEFAULT_SIZE_UNIT: SizeUnit = "MB";
/** U-7 ① / Phase 4（§4-3）：size 字段（file_size）单位下拉 KB/MB/GB —— 显示按所选单位换算，提交始终是字节。
 *  单位**存进 filter.unit**（唯一事实源）：between 两侧共用、换源/AI 合并外部改写数值后单位不丢。
 *  P1-3：非零小值（如 500 字节在 MB 下显示 0.000）自动落到 KB —— 否则显示截断成 "0"，
 *  用户一失焦就把筛选条件静默改成 0 字节。 */
function SizeValue({ filter, onChange }: { filter: MetadataFilter; onChange: (f: MetadataFilter) => void }) {
  const unit = filter.unit ?? DEFAULT_SIZE_UNIT;
  const setUnit = (u: SizeUnit) => onChange({ ...filter, unit: u });
  const num = typeof filter.value === "number" && Number.isFinite(filter.value) ? filter.value : NaN;
  // 已选单位下按 3 位小数显示会归零但实际非零 → 显示与提交都用 KB（不丢信息）
  const effUnit: SizeUnit =
    num > 0 && unit !== "KB" && Math.round((num / SIZE_FACTORS[unit]) * 1000) / 1000 === 0 ? "KB" : unit;
  const factor = SIZE_FACTORS[effUnit];
  const display = Number.isNaN(num) ? "" : String(Math.round((num / factor) * 1000) / 1000);
  const commit = (raw: string) => {
    if (raw.trim() === "") { onChange({ ...filter, value: undefined }); return; }
    const n = Number(raw);
    if (Number.isNaN(n)) return;
    onChange({ ...filter, value: Math.round(n * factor), unit: effUnit });
  };
  return (
    <div className="flex min-w-0 items-stretch gap-1">
      <DraftInput ariaLabel="条件值" type="number" step="0.1" placeholder="输入数值" displayValue={display} onCommit={commit} className={`${controlClass} w-full`} />
      <select aria-label="数值单位" value={effUnit} onChange={(e) => setUnit(e.target.value as SizeUnit)} className={`${controlClass} w-16 shrink-0 text-[var(--color-text-secondary)]`}>
        <option value="KB">KB</option><option value="MB">MB</option><option value="GB">GB</option>
      </select>
    </div>
  );
}
/** Phase 4（§4-3）：file_size between 的**单个共享单位** —— 两侧输入按同一单位换算、提交字节。
 *  单位状态由组件持有：外部表达式变化（换源/AI 合并重写 min/max）只改数值不重置单位。 */
function SizeBetweenValue({ filter, onChange }: { filter: MetadataFilter; onChange: (f: MetadataFilter) => void }) {
  const unit = filter.unit ?? DEFAULT_SIZE_UNIT;
  const factor = SIZE_FACTORS[unit];
  const setUnit = (u: SizeUnit) => onChange({ ...filter, unit: u });
  const fmt = (v: MetadataFilter["min"]): string =>
    typeof v === "number" && Number.isFinite(v) ? String(Math.round((v / factor) * 1000) / 1000) : "";
  const commit = (side: "min" | "max", raw: string) => {
    if (raw.trim() === "") { onChange({ ...filter, [side]: undefined, unit }); return; }
    const n = Number(raw);
    if (Number.isNaN(n)) return;
    onChange({ ...filter, [side]: Math.round(n * factor), unit });
  };
  const lo = typeof filter.min === "number" ? filter.min : Number(filter.min);
  const hi = typeof filter.max === "number" ? filter.max : Number(filter.max);
  const inverted = Number.isFinite(lo) && Number.isFinite(hi) && lo > hi;
  return (
    <div className="flex min-w-0 flex-col items-stretch gap-1">
      <div className="grid grid-cols-[minmax(0,1fr)_16px_minmax(0,1fr)_56px] items-center gap-1">
        <DraftInput ariaLabel="范围下限" type="number" step="0.1" placeholder="下限" displayValue={fmt(filter.min)} onCommit={(raw) => commit("min", raw)} className={`${controlClass} w-full`} />
        <span className="text-center text-[11px] text-[var(--color-text-tertiary)]">至</span>
        <DraftInput ariaLabel="范围上限" type="number" step="0.1" placeholder="上限" displayValue={fmt(filter.max)} onCommit={(raw) => commit("max", raw)} className={`${controlClass} w-full`} />
        <select aria-label="数值单位" value={unit} onChange={(e) => setUnit(e.target.value as SizeUnit)} className={`${controlClass} w-full shrink-0 text-[var(--color-text-secondary)]`}>
          <option value="KB">KB</option><option value="MB">MB</option><option value="GB">GB</option>
        </select>
      </div>
      {inverted && <p className="text-[10px] text-[var(--color-danger)]">范围下限不能大于上限</p>}
    </div>
  );
}
/** U-7 ②：date 快捷（今天/本周/本月/今年）—— start 侧（gte/区间下限）写期初，end 侧（lte/区间上限）写期末；
 *  选完立即落值并回到「自定义」，之后仍可手工改日期。
 *  P0（日期线格式）：收发一律 YYYY-MM-DD 字符串（后端只认字符串；空串 → undefined 表示未填）。 */
function DateValue({ value, side, onChange }: { value: string | number | undefined; side: "start" | "end"; onChange: (v: string | number | undefined) => void }) {
  const [pick, setPick] = useState("");
  return (
    <div className="flex min-w-0 items-stretch gap-1">
      <input aria-label="条件值" type="date" value={toDateInputValue(value)} onChange={(e) => { const v = e.target.value; onChange(v ? v : undefined); }} className={`${controlClass} w-full`} />
      <select aria-label="日期快捷" value={pick} onChange={(e) => { const kind = e.target.value as DateShortcutKind | ""; if (!kind) return; const now = new Date(); onChange(side === "end" ? shortcutEndMs(kind, now) : shortcutStartMs(kind, now)); setPick(""); }} className={`${controlClass} w-[72px] shrink-0 text-[var(--color-text-secondary)]`}>
        <option value="">自定义</option>
        {DATE_SHORTCUT_OPTIONS.map((o) => <option key={o.kind} value={o.kind}>{o.label}</option>)}
      </select>
    </div>
  );
}
/** 文本/数值输入的本地 draft：输入时不提交到 store（不触发后端查询），失焦或 Enter 才提交。
 *  P0-1：解决「每输入一个字符 → commit → 行重建 → 失焦」问题。 */
function DraftInput({ ariaLabel = "条件值", displayValue, onCommit, className, placeholder, type = "text", step, suffix, min, max }: { ariaLabel?: string; displayValue: string; onCommit: (display: string) => void; className?: string; placeholder?: string; type?: string; step?: string; suffix?: string; min?: number; max?: number; }) {
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
  return <div className="relative min-w-0"><input aria-label={ariaLabel} type={type} step={step} min={min} max={max} value={draft} placeholder={placeholder} className={className} onChange={(e) => { dirty.current = true; setDraft(e.target.value); }} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }} />{suffix && <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[10px] text-[var(--color-text-tertiary)]">{suffix}</span>}</div>;
}

function makeCond(field: FieldKey, flatTags: FlatTag[]): LeafCond {
  if (field.startsWith(FACET_FIELD_PREFIX)) {
    // V24（Phase 7-8）：数值分面行 —— 默认「≥ 分面下限」，between 时补上界
    const facetKey = field.slice(FACET_FIELD_PREFIX.length);
    const domain = useNumericDomainStore.getState().domains.find((d) => d.key === field);
    const value = domain?.min ?? 0;
    return { type: "facetNumber", facetKey, op: "gte", value, maxValue: null };
  }
  if (field === "search") return { type: "search", value: "" }; if (field === "tag") return { type: "tag", facetKey: flatTags[0]?.facet ?? "scene", tagIds: [], mode: "any", includeDescendants: true }; if (field === "excludeTag") return { type: "excludeTag", facetKey: flatTags[0]?.facet ?? "", tagIds: [] }; if (field === "assetType") return { type: "assetType", value: "image" }; if (field === "untagged") return { type: "untagged" }; if (field === "facetHasAny") return { type: "facetHasAny", facetKey: flatTags[0]?.facet ?? "scene" }; if (field === "facetMissing") return { type: "facetMissing", facetKey: flatTags[0]?.facet ?? "scene" }; const option = FIELD_OPTIONS.find((item) => item.key === field); const op = option?.ops?.[0] ?? "eq"; return { type: "metadata", filter: changeMetadataOp({ key: field as MetadataFilterKey, op }, op) }; }
function fieldFromCond(cond: LeafCond): FieldKey { return cond.type === "metadata" ? cond.filter.key : cond.type === "facetNumber" ? `${FACET_FIELD_PREFIX}${cond.facetKey}` : cond.type; }
/** V24（Phase 7-8）：数值分面 op 切换 —— 切到 between 时补默认上界（下限+步进），切走时清掉 */
function changeFacetNumberOp(cond: Extract<LeafCond, { type: "facetNumber" }>, op: FacetNumberOp): Extract<LeafCond, { type: "facetNumber" }> {
  if (op === cond.op) return cond;
  if (op === "between") {
    const domain = useNumericDomainStore.getState().domains.find((d) => d.key === `${FACET_FIELD_PREFIX}${cond.facetKey}`);
    const step = domain?.step && domain.step > 0 ? domain.step : 1;
    return { ...cond, op, maxValue: cond.maxValue ?? cond.value + step };
  }
  return { ...cond, op, maxValue: null };
}
type FacetNumberOp = Extract<LeafCond, { type: "facetNumber" }>["op"];
function changeMetadataOp(filter: MetadataFilter, op: MetadataOp): MetadataFilter { if (op === "between") return { key: filter.key, op, min: filter.min ?? filter.value, max: filter.max ?? filter.value }; if (op === "in") return { key: filter.key, op, values: filter.values ?? (filter.value === undefined ? [] : [filter.value]) }; return { key: filter.key, op, value: filter.value ?? filter.min }; }
/** Phase 4（§4-3）：between 只有 circular（色相跨 0°）允许 min > max；其余倒置视为未完成，不写进条件。
 *  circular 集合来自 NumericDomain（单一事实源）；未加载时保守按非环形处理（不含倒置）。 */
function isComplete(cond: LeafCond, circularKeys: ReadonlySet<string> = new Set()): boolean {
  if (cond.type === "tag" || cond.type === "excludeTag") return cond.tagIds.length > 0;
  if (cond.type === "search") return cond.value.trim().length > 0;
  if (cond.type === "facetNumber") {
    if (!Number.isFinite(cond.value)) return false;
    if (cond.op === "between") {
      if (cond.maxValue == null || !Number.isFinite(cond.maxValue)) return false;
      return cond.value <= cond.maxValue; // 数值分面无环形量（色相是内置字段），倒置视为未完成
    }
    return true;
  }
  if (cond.type !== "metadata") return true;
  if (cond.filter.op === "between") {
    if (cond.filter.min === undefined || cond.filter.max === undefined) return false;
    const lo = typeof cond.filter.min === "number" ? cond.filter.min : Number(cond.filter.min);
    const hi = typeof cond.filter.max === "number" ? cond.filter.max : Number(cond.filter.max);
    if (Number.isFinite(lo) && Number.isFinite(hi) && lo > hi && !circularKeys.has(cond.filter.key)) return false;
    return true;
  }
  if (cond.filter.op === "in") return Boolean(cond.filter.values?.length);
  return cond.filter.value !== undefined && cond.filter.value !== "";
}
function rowsToExpr(rows: Row[], mode: GroupMode, circularKeys?: ReadonlySet<string>): QueryExpr | undefined { const children = rows.filter((row) => isComplete(row.cond, circularKeys)).map((row) => { const leaf: QueryExpr = { op: "leaf", cond: row.cond }; return row.negated ? { op: "not", child: leaf } as QueryExpr : leaf; }); if (!children.length) return undefined; return children.length === 1 ? children[0] : { op: mode, children }; }
function exprToRows(expr?: QueryExpr): { mode: GroupMode; rows: Row[]; unsupported: boolean } { if (!expr) return { mode: "and", rows: [], unsupported: false }; const mode: GroupMode = expr.op === "or" ? "or" : "and"; const children = expr.op === "and" || expr.op === "or" ? expr.children : [expr]; const rows: Row[] = []; let unsupported = false; for (const child of children) { if (child.op === "leaf") rows.push({ id: uid(), negated: false, cond: child.cond }); else if (child.op === "not" && child.child.op === "leaf") rows.push({ id: uid(), negated: true, cond: child.child.cond }); else unsupported = true; } return { mode, rows, unsupported }; }
/** P0（日期线格式）：DateValue 的显示层归一 —— YYYY-MM-DD 字符串原样返回；
 *  历史持久化里的 epoch 数字（旧格式）转本地日期；其余返回空串。提交侧只写字符串。 */
function toDateInputValue(value: string | number | undefined): string {
  if (typeof value === "string") return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return toIsoDateString(d);
  }
  return "";
}
