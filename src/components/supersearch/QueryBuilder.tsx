/** 飞书式条件公式构建器：三区竖排，每区 = 一个根「条件组」，组内可嵌套子条件组。
 *  2026-09-06 改造（docs/review/超级搜索条件组前端UI改造方案）：
 *  - 视图模型 = 递归组/叶子（VGroup/VLeaf），与 QueryExpr 树递归互转，
 *    任何 AI 产出或历史持久化的树都能 100% 还原成可编辑结构（不再有「复杂条件只读」降级）。
 *  - 连接词分段控件：必须区三态（全部满足 / 满足任一 / 至少N项），排除区两态。
 *  - 「至少N项」编译为 minMatch 语义：N=1 → OR、N=全部 → AND、中间 → 组合展开（上限内）。
 *  - NOT(组) 无组级取反开关，渲染为「整组取反」角标卡片（组内仍可编辑）。
 *  - FB5-05（§9.8）：已有非空 tagId 优先 tagStore options，找不到再从 resolvedTags 注入
 *    synthetic option，两边都找不到时显示「标签 #id」，绝不退回「选择标签」。 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { normalizeExpr, serializeExpr } from "@/utils/queryExprUtils";
import { reorderShould } from "@/utils/planUtils";
import type { ExprPath } from "@/utils/queryExprUtils";
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
type FlatTag = { id: number; name: string; facet: string; aliases: string[] };
type TagCondData = { facetKey: string; tagIds: number[]; mode: "any" | "all"; includeDescendants: boolean; termQuery: string | null; termMatch: TermMatchKey };
type FieldOption = { key: FieldKey; label: string; group: "关键词" | "标签" | "素材" | "颜色" | "定位" | "时间" | "拍摄设备" | "视频" | "数值分面"; kind?: "number" | "text" | "date" | "size" | "duration" | "resolution"; ops?: MetadataOp[] };

// ═════════ 递归条件组视图模型（区 = 根条件组；expr 树仍是唯一持久化事实源）═════════
/** 组连接词：全部满足（且）/ 满足任一（或）/ 至少 N 项（minMatch，编译时展开）。 */
type VGroupOp = "and" | "or" | "minMatch";
type VLeaf = { kind: "leaf"; id: string; negated: boolean; cond: LeafCond };
type VGroup = { kind: "group"; id: string; op: VGroupOp; min: number; /** NOT(组)：无组级取反开关，渲染「整组取反」角标 */ groupNegated?: boolean; /** P3：子组折叠收起（仅视图状态，expr 不存） */ collapsed?: boolean; items: VNode[] };
type VNode = VLeaf | VGroup;
/** 嵌套深度软上限（根组 = 1 层）：后端不限制，仅 UI 收敛。 */
const MAX_GROUP_DEPTH = 3;
/** minMatch 组合展开上限：C(n,k) 超过则禁用该 N 档（UI 收敛，避免组合爆炸）。 */
const MAX_MIN_COMBOS = 128;

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
  // Phase 4（§5.1 / 4-5）：rating / folder 从后端白名单补进条件行。
  // rating 是 Stars domain（ValueInput eq → 星选）；folder 走枚举（命中数下拉/`属于任一` chip）。
  { key: "rating", label: "评级", group: "素材", kind: "number", ops: NUMERIC_OPS },
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
  // Phase 4（§5.3）：允许 between 倒置的 key 集合（= domain.circular，如 dominant_hue）
  const circularKeys = useMemo(() => new Set(numericDomains.filter((d) => d.circular).map((d) => d.key)), [numericDomains]);
  // ═══ 必须满足区：递归条件组视图（根组连接词三态，组内可嵌套子组）═══
  const [root, setRoot] = useState<VGroup>(emptyGroup);
  const [focusLeafId, setFocusLeafId] = useState<string | null>(null);
  const lastLocalSignature = useRef<string | null>(null);
  const exprSignature = expr ? serializeExpr(expr) : "";
  useEffect(() => {
    // 沿用签名比对防回跳：本组件提交的 expr 不回灌视图（保留本地草稿行/空组）；
    // 外部变更（AI/换源/chips 删除/持久化恢复）→ 从 expr 递归还原整棵可编辑组树。
    if (lastLocalSignature.current === exprSignature) {
      lastLocalSignature.current = null;
      return;
    }
    setRoot(expr ? asRootGroup(exprToNode(expr)) : emptyGroup());
  }, [exprSignature]);
  const commitFilter = (next: VGroup) => {
    const nextExpr = nodeToExpr(next, circularKeys);
    const normalized = nextExpr ? normalizeExpr(nextExpr) : undefined;
    setRoot(next);
    lastLocalSignature.current = normalized ? serializeExpr(normalized) : "";
    setExpr(normalized);
  };
  const editFilter = useCallback((fn: (r: VGroup) => VGroup) => commitFilter(fn(root)), [root, circularKeys, setExpr]);
  // ═══ 排除区：递归条件组视图（根组连接词两态：命中任一 / 全部命中；行内禁取反，避免双重否定）═══
  const mustNotRoot = plan?.mustNot ?? null;
  const mustNotSig = mustNotRoot ? serializeExpr(mustNotRoot) : "";
  const [exRoot, setExRoot] = useState<VGroup>(emptyMustNotGroup);
  const lastExSignature = useRef<string | null>(null);
  useEffect(() => {
    if (lastExSignature.current === mustNotSig) {
      lastExSignature.current = null;
      return;
    }
    setExRoot(mustNotRoot ? asRootGroup(exprToNode(mustNotRoot)) : emptyMustNotGroup());
  }, [mustNotSig]);
  const commitMustNot = (next: VGroup) => {
    // allowNegated=false：排除区树内禁 NOT（与后端 validate 同规则），遗留取反叶子不回写
    const nextExpr = nodeToExpr(next, circularKeys, false);
    const normalized = nextExpr ? normalizeExpr(nextExpr) : undefined;
    setExRoot(next);
    lastExSignature.current = normalized ? serializeExpr(normalized) : "";
    setPlanMustNot(normalized);
  };
  const editMustNot = useCallback((fn: (r: VGroup) => VGroup) => commitMustNot(fn(exRoot)), [exRoot, circularKeys, setPlanMustNot]);
  // U-6：诊断叶子的 expr 路径（与后端 collect_leaves 对齐：NOT 子树按下标 0 展开）。
  // 视图叶子按 DFS 序与 expr 叶子一一配对；未完成叶子不进 expr，配对时跳过保持对齐。
  const filterLeafPathById = useMemo(() => leafPathMap(root, collectLeafPaths(expr), circularKeys), [root, exprSignature, circularKeys]);
  const mustNotLeafPathById = useMemo(() => leafPathMap(exRoot, collectLeafPaths(mustNotRoot ?? undefined), circularKeys), [exRoot, mustNotSig, circularKeys]);
  const clearAll = () => { lastLocalSignature.current = ""; lastExSignature.current = ""; setRoot(emptyGroup()); setExRoot(emptyMustNotGroup()); clearConditions(); };
  // P3：拖拽调层级（行/子组 → 组内重排或搬入其他组）
  const [dndId, setDndId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ groupId: string; index: number } | null>(null);
  const drag: DragState = { dndId, dropAt, setDndId, setDropAt };
  const [shouldDragIndex, setShouldDragIndex] = useState<number | null>(null);
  const [shouldDropAt, setShouldDropAt] = useState<number | null>(null);
  // U-6/§4.5：四指标诊断（diagnose_search_plan_cmd → PlanDiagnostics）——
  // 叶子带 zone（filter/mustNot），加分项带 index，warnings 与列表同批。
  const [diag, setDiag] = useState<PlanDiagnostics | null>(null);
  const exprKey = expr ? serializeExpr(expr) : "";
  useEffect(() => {
    if (!expr && !mustNotRoot && plan?.should.length === 0) {
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
  }, [exprKey, plan ? `${plan.minimumShouldMatch}#${plan.should.length}#${plan.mustNot ? serializeExpr(plan.mustNot) : ""}` : "manual", planRevision, mustNotSig]);
  // U-5：优先（should）= 软排序，plan.should 为 store 单源，是非嵌套叶子（ShouldClause.cond）。
  // P1：minimumShouldMatch 恒 0（一条不中也全部保留，只调先后）；权重不外露，由位置统一生成。
  const shouldList = plan?.should ?? [];
  const setShould = (next: typeof shouldList) => setPlanShould(next, 0);
  const moveShould = (index: number, delta: -1 | 1) => {
    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= shouldList.length) return;
    setShould(reorderShould(shouldList, index, nextIndex));
  };
  const clearShouldDrag = () => {
    setShouldDragIndex(null);
    setShouldDropAt(null);
  };
  const dropShouldAt = (index: number) => {
    if (shouldDragIndex != null) {
      // DropLine index is a final insertion slot; when moving down, deletion shifts it left.
      const target = shouldDragIndex < index ? index - 1 : index;
      setShould(reorderShould(shouldList, shouldDragIndex, target));
    }
    clearShouldDrag();
  };
  const patchShould = (index: number, next: ShouldClause) => setShould(shouldList.map((x, i) => (i === index ? next : x)));

  const hasAnyConditions = root.items.length > 0 || exRoot.items.length > 0 || shouldList.length > 0;
  // P1：底部实时人话预览（必须 / 排除 / 优先），随编辑即时更新；无任何完成条件时不显示。
  const previewSentence = useMemo(() => {
    const segs: string[] = [];
    const fb = groupBrief(root, allTagOptions, circularKeys);
    if (fb) {
      const lead = root.op === "and" ? "同时满足" : root.op === "or" ? "满足以下任一" : "满足";
      segs.push(`显示${lead}：${fb}`);
    }
    const eb = groupBrief(exRoot, allTagOptions, circularKeys);
    if (eb) segs.push(`排除：${eb}`);
    const sb = shouldList.map((s) => (isComplete(s.cond, circularKeys) ? leafBrief(s.cond, allTagOptions) : "")).filter(Boolean);
    if (sb.length > 0) segs.push(`优先依次：${sb.join("、")}`);
    return segs.join("；");
  }, [root, exRoot, shouldList, allTagOptions, circularKeys]);
  const rootOpSentence = root.op === "and" ? "全部满足才显示" : root.op === "or" ? "满足任一即显示" : "满足至少 N 项才显示";
  const exOpSentence = exRoot.op === "and" ? "全部命中才不显示" : "命中任一条就不显示";
  return (
    <section className="overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)]" aria-label="条件公式">
      <div className="flex min-h-10 items-center gap-2 border-b border-[var(--color-border)] px-3 py-2"><span className="text-xs font-semibold text-[var(--color-text)]">筛选条件</span><span className="text-[11px] text-[var(--color-text-tertiary)]">AI 生成后可继续修改</span>{hasAnyConditions && <button type="button" onClick={clearAll} className="ml-auto text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text)]">清除全部</button>}</div>
      {/* 三区并排三个框（每框内部条件竖排）；窄屏回落为单列 */}
      <div className="grid grid-cols-1 items-start gap-2 px-3 py-2.5 md:grid-cols-3">
        {/* ═══ 框一：必须满足（plan.filter）═══ */}
        <section id="qb-zone-filter" data-zone="filter" className="flex min-w-0 flex-col rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <span className="text-xs font-semibold text-[var(--color-text)]">必须满足</span>
            <span className="ml-auto">
              <OpSegmented
                ariaLabel="条件连接方式"
                value={root.op}
                options={FILTER_OP_OPTIONS}
                onChange={(op) => editFilter((r) => patchGroupById(r, root.id, { op: op as VGroupOp, ...(op === "minMatch" ? { min: defaultMinFor(root.items.length) } : {}) }))}
              />
            </span>
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10px] leading-4 text-[var(--color-text-tertiary)]">
            {rootOpSentence}
            {root.op === "minMatch" && <MinSelect count={root.items.length} value={root.min} onChange={(n) => editFilter((r) => patchGroupById(r, root.id, { min: n }))} />}
          </p>
          <div className="mt-1.5">
            <GroupEditor
              node={root}
              depth={1}
              zone="filter"
              allowGroups
              allowMin
              allTagOptions={allTagOptions}
              circularKeys={circularKeys}
              diag={diag}
              leafPaths={filterLeafPathById}
              focusLeafId={focusLeafId}
              setFocusLeafId={setFocusLeafId}
              drag={drag}
              edit={editFilter}
              onMoveCondition={(to, path) => moveConditionBetweenZones("filter", to, path)}
            />
          </div>
        </section>
        {/* ═══ 框二：优先满足（plan.should，软排序：中了靠前、不中也显示；P1 单行、无权重/无连接词）═══ */}
        <section id="qb-zone-should" data-zone="should" className="flex min-w-0 flex-col rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-2">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold text-[var(--color-text)]">优先满足</span>
            <span className="ml-auto rounded bg-[var(--color-surface-hover)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-tertiary)]">软排序</span>
          </div>
          <p className="mt-0.5 text-[10px] leading-4 text-[var(--color-text-tertiary)]">越靠上越优先 · 一条不中也照样显示，只是排后面</p>
          <div className="mt-1.5 flex flex-col gap-1.5">
            {shouldList.map((sc, i) => {
              const field = fieldFromCond(sc.cond);
              const needsOperator = leafNeedsOperator(sc.cond);
              return (
                <div key={`should-${i}`}>
                  <div
                    data-testid="should-drop-line"
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      setShouldDropAt(i);
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      dropShouldAt(i);
                    }}
                    className={`-my-0.5 rounded-full transition-all ${shouldDragIndex != null && shouldDropAt === i ? "h-2 bg-[var(--color-accent)]/50" : "h-1"}`}
                  />
                  <div className="flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-1.5">
                    <span className="w-5 shrink-0 text-center text-[10px] font-medium text-[var(--color-accent)]">{i + 1}</span>
                    <button
                      type="button"
                      draggable
                      aria-label={`拖动优先条件 ${i + 1}`}
                      title="拖动调整优先顺序"
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", `should-${i}`);
                        setShouldDragIndex(i);
                      }}
                      onDragEnd={clearShouldDrag}
                      className={`flex size-6 shrink-0 cursor-grab items-center justify-center rounded text-xs text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] ${shouldDragIndex === i ? "opacity-40" : ""}`}
                    >
                      ⠿
                    </button>
                    <button type="button" aria-label="上移优先条件" disabled={i === 0} onClick={() => moveShould(i, -1)} className="flex size-6 shrink-0 items-center justify-center rounded text-xs text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] disabled:cursor-not-allowed disabled:opacity-30">↑</button>
                    <button type="button" aria-label="下移优先条件" disabled={i === shouldList.length - 1} onClick={() => moveShould(i, 1)} className="flex size-6 shrink-0 items-center justify-center rounded text-xs text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] disabled:cursor-not-allowed disabled:opacity-30">↓</button>
                    <div className="w-[104px] shrink-0"><FieldSelect value={field} onChange={(next) => patchShould(i, { ...sc, cond: makeCond(next, allTagOptions) })} /></div>
                    {needsOperator && <div className="w-[76px] shrink-0"><ConditionOperator cond={sc.cond} negated={false} onChange={(p) => { if (p.cond) patchShould(i, { ...sc, cond: p.cond }); }} /></div>}
                    <div className="min-w-0 flex-1"><ConditionValue cond={sc.cond} allTagOptions={allTagOptions} onChange={(cond) => patchShould(i, { ...sc, cond })} /></div>
                    <MoveMenu zone="should" onMove={(t) => moveConditionBetweenZones("should", t, i)} />
                    <button type="button" aria-label={`移除优先条件 ${i + 1}`} onClick={() => setShould(shouldList.filter((_, j) => j !== i))} className="flex size-7 shrink-0 items-center justify-center rounded text-base text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-danger)]">×</button>
                  </div>
                  {/* §3.5：evidence 原文回显（AI 判断可逐条改判的草稿），不占主行 */}
                  {sc.evidence ? (
                    <div className="pr-1 pt-0.5 text-right text-[10px] text-[var(--color-text-tertiary)]">「{sc.evidence}」</div>
                  ) : null}
                </div>
              );
            })}
            <div
              data-testid="should-drop-line"
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setShouldDropAt(shouldList.length);
              }}
              onDrop={(event) => {
                event.preventDefault();
                dropShouldAt(shouldList.length);
              }}
              className={`-my-0.5 rounded-full transition-all ${shouldDragIndex != null && shouldDropAt === shouldList.length ? "h-2 bg-[var(--color-accent)]/50" : "h-1"}`}
            />
            {shouldList.length === 0 && <p className="text-[11px] leading-4 text-[var(--color-text-tertiary)]">把「最好有」的倾向加在这里：只影响排序先后，不会筛掉任何素材。</p>}
          </div>
          <button type="button" onClick={() => setShould([...shouldList, { cond: makeCond("tag", allTagOptions), weight: 0.5, label: "" }])} className="mt-1.5 h-7 px-1 text-left text-xs font-medium text-[var(--color-status)] hover:opacity-80">＋ 添加优先条件</button>
        </section>
        {/* ═══ 框三：排除（plan.mustNot）：根组连接词两态（命中任一 / 全部命中），行内禁取反 ═══ */}
        <section id="qb-zone-mustnot" data-zone="mustNot" className="flex min-w-0 flex-col rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <span className="text-xs font-semibold text-[var(--color-text)]">排除</span>
            <span className="ml-auto">
              <OpSegmented
                ariaLabel="排除连接方式"
                value={exRoot.op === "and" ? "and" : "or"}
                options={MUSTNOT_OP_OPTIONS}
                onChange={(op) => editMustNot((r) => patchGroupById(r, exRoot.id, { op: op as VGroupOp }))}
              />
            </span>
          </div>
          <p className="mt-0.5 text-[10px] leading-4 text-[var(--color-text-tertiary)]">{exOpSentence}</p>
          <div className="mt-1.5">
            <GroupEditor
              node={exRoot}
              depth={1}
              zone="mustNot"
              allowGroups
              allowMin={false}
              allTagOptions={allTagOptions}
              circularKeys={circularKeys}
              diag={diag}
              leafPaths={mustNotLeafPathById}
              focusLeafId={focusLeafId}
              setFocusLeafId={setFocusLeafId}
              drag={drag}
              edit={editMustNot}
              onMoveCondition={(to, path) => moveConditionBetweenZones("mustNot", to, path)}
            />
          </div>
        </section>
      </div>
      {/* P1：实时人话预览 —— 读这句话即可判断条件配得对不对，无需理解布尔树 */}
      {previewSentence && (
        <div className="border-t border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-[11px] leading-5 text-[var(--color-text-secondary)]">
          <span className="text-[var(--color-text-tertiary)]">预览：</span>{previewSentence}
        </div>
      )}
    </section>
  );
}

// ═════════ 递归组模型 ⇄ QueryExpr 互转（and/or/not/leaf 四种节点全覆盖，无 unsupported 分支）═════════

/** expr → 视图节点。leaf → 叶子；not(leaf) → 行内取反叶子；not(组) → 「整组取反」角标组；
 *  and/or → 组（子节点递归）。任何 AI 产出或历史持久化的树都能完整还原成可编辑结构。 */
function exprToNode(e: QueryExpr): VNode {
  if (e.op === "leaf") return { kind: "leaf", id: uid(), negated: false, cond: e.cond };
  if (e.op === "not") {
    const inner = exprToNode(e.child);
    if (inner.kind === "leaf") return { ...inner, negated: !inner.negated };
    return { ...inner, groupNegated: !inner.groupNegated };
  }
  return { kind: "group", id: uid(), op: e.op, min: 1, items: e.children.map(exprToNode) };
}

/** 根节点必须是组：单叶子 expr 包一层平铺根组（不画卡片，视觉与旧版一致）。 */
function asRootGroup(n: VNode): VGroup {
  return n.kind === "group" ? n : { kind: "group", id: uid(), op: "and", min: 1, items: [n] };
}

function emptyGroup(): VGroup {
  return { kind: "group", id: uid(), op: "and", min: 1, items: [] };
}

/** 排除区空态根组：默认「命中任一」（OR）—— 空区的分段控件不应显示「全部命中」。 */
function emptyMustNotGroup(): VGroup {
  return { kind: "group", id: uid(), op: "or", min: 1, items: [] };
}

function defaultMinFor(itemCount: number): number {
  return itemCount >= 2 ? 2 : 1;
}

/** 视图节点 → expr。未完成叶子按旧规则剔除；空组剔除；单子项组折叠（normalizeExpr 再兜底）。
 *  allowNegated=false（排除区）：取反叶子/取反组直接剔除（后端禁止 must_not 树内 NOT）。 */
function nodeToExpr(n: VNode, circularKeys: ReadonlySet<string>, allowNegated = true): QueryExpr | undefined {
  if (n.kind === "leaf") {
    if (!isComplete(n.cond, circularKeys)) return undefined;
    const leaf: QueryExpr = { op: "leaf", cond: n.cond };
    if (!n.negated) return leaf;
    return allowNegated ? { op: "not", child: leaf } : undefined;
  }
  const children = n.items.map((it) => nodeToExpr(it, circularKeys, allowNegated)).filter((x): x is QueryExpr => Boolean(x));
  if (children.length === 0) return undefined;
  const inner: QueryExpr = children.length === 1 ? children[0] : groupExpr(n.op, n.min, children);
  return n.groupNegated ? { op: "not", child: inner } : inner;
}

/** 组连接词 → expr：minMatch 编译为 minMatch 语义 —— N=1 → OR、N=全部 → AND、
 *  中间 N → C(n,k) 个 AND 组的 OR（组合数超上限退回 OR，UI 侧已禁用该档）。 */
function groupExpr(op: VGroupOp, min: number, children: QueryExpr[]): QueryExpr {
  if (op === "and") return { op: "and", children };
  if (op === "or") return { op: "or", children };
  const k = Math.max(1, Math.min(children.length, Math.floor(min)));
  if (k <= 1) return { op: "or", children };
  if (k >= children.length) return { op: "and", children };
  if (combosCount(children.length, k) > MAX_MIN_COMBOS) return { op: "or", children };
  const groups: QueryExpr[] = [];
  const pick = (start: number, acc: QueryExpr[]) => {
    if (acc.length === k) {
      groups.push({ op: "and", children: [...acc] });
      return;
    }
    for (let i = start; i <= children.length - (k - acc.length); i += 1) pick(i + 1, [...acc, children[i]]);
  };
  pick(0, []);
  return { op: "or", children: groups };
}

function combosCount(n: number, k: number): number {
  if (k < 1 || k > n) return 0;
  let c = 1;
  for (let i = 1; i <= k; i += 1) c = (c * (n - k + i)) / i;
  return Math.round(c);
}

// ═════════ 视图树编辑（全部按节点 id 定位，天然免受 expr 单子项折叠/拍平影响）═════════

function patchGroupById(rootNode: VGroup, id: string, patch: Partial<VGroup>): VGroup {
  if (rootNode.id === id) return { ...rootNode, ...patch };
  return { ...rootNode, items: rootNode.items.map((it) => (it.kind === "group" ? patchGroupById(it, id, patch) : it)) };
}

function replaceNodeById(rootNode: VGroup, id: string, next: VNode): VGroup {
  return { ...rootNode, items: rootNode.items.map((it) => (it.id === id ? next : it.kind === "group" ? replaceNodeById(it, id, next) : it)) };
}

function removeNodeById(rootNode: VGroup, id: string): VGroup {
  return { ...rootNode, items: rootNode.items.filter((it) => it.id !== id).map((it) => (it.kind === "group" ? removeNodeById(it, id) : it)) };
}

function addToGroupById(rootNode: VGroup, groupId: string, item: VNode): VGroup {
  if (rootNode.id === groupId) return { ...rootNode, items: [...rootNode.items, item] };
  return { ...rootNode, items: rootNode.items.map((it) => (it.kind === "group" ? addToGroupById(it, groupId, item) : it)) };
}

/** P3 拖拽调层级：把 id 节点搬到 toGroupId 组的 index 位置（同组内重排或跨组搬移）。
 *  守卫：组不能搬进自己/自己的后代；搬入后总深度超过软上限（MAX_GROUP_DEPTH）不搬；
 *  越界 index 收敛到 [0, len]。 */
function moveNodeById(rootNode: VGroup, id: string, toGroupId: string, index: number): VGroup {
  const moving = findNodeById(rootNode, id);
  if (!moving) return rootNode;
  if (moving.kind === "group" && (moving.id === toGroupId || findNodeById(moving, toGroupId))) return rootNode;
  const targetDepth = depthOfGroup(rootNode, toGroupId);
  if (targetDepth == null || targetDepth + subtreeHeight(moving) > MAX_GROUP_DEPTH) return rootNode;
  const from = findParentOf(rootNode, id);
  const without = removeNodeById(rootNode, id);
  // 同组内搬移：删除节点后原下标左侧的项左移，目标 index 相应 -1
  let at = Math.max(0, index);
  if (from && from.parent.id === toGroupId && from.index < index) at -= 1;
  return insertNodeById(without, toGroupId, at, moving);
}

/** 组节点在树中的深度（根组 = 1；找不到返回 undefined）。 */
function depthOfGroup(rootNode: VGroup, id: string, depth = 1): number | undefined {
  if (rootNode.id === id) return depth;
  for (const it of rootNode.items) {
    if (it.kind === "group") {
      const hit = depthOfGroup(it, id, depth + 1);
      if (hit != null) return hit;
    }
  }
  return undefined;
}

/** 子树高度（叶子 = 1）。 */
function subtreeHeight(n: VNode): number {
  if (n.kind === "leaf") return 1;
  return 1 + n.items.reduce((max, it) => Math.max(max, subtreeHeight(it)), 0);
}

function findNodeById(rootNode: VNode, id: string): VNode | undefined {
  if (rootNode.id === id) return rootNode;
  if (rootNode.kind !== "group") return undefined;
  for (const it of rootNode.items) {
    const hit = findNodeById(it, id);
    if (hit) return hit;
  }
  return undefined;
}

function findParentOf(rootNode: VGroup, id: string): { parent: VGroup; index: number } | undefined {
  for (let i = 0; i < rootNode.items.length; i += 1) {
    const it = rootNode.items[i];
    if (it.id === id) return { parent: rootNode, index: i };
    if (it.kind === "group") {
      const hit = findParentOf(it, id);
      if (hit) return hit;
    }
  }
  return undefined;
}

function insertNodeById(rootNode: VGroup, groupId: string, index: number, item: VNode): VGroup {
  if (rootNode.id === groupId) {
    const items = [...rootNode.items];
    items.splice(Math.max(0, Math.min(index, items.length)), 0, item);
    return { ...rootNode, items };
  }
  return { ...rootNode, items: rootNode.items.map((it) => (it.kind === "group" ? insertNodeById(it, groupId, index, item) : it)) };
}

/** P3 折叠摘要：组内叶子数（递归）。 */
function countNodeLeaves(n: VNode): number {
  if (n.kind === "leaf") return 1;
  return n.items.reduce((sum, it) => sum + countNodeLeaves(it), 0);
}

/** 诊断叶子的下标链（根→子组→行）。NOT 子树按下标 0 展开 —— 与后端 collect_leaves 严格对齐。 */
function collectLeafPaths(e: QueryExpr | undefined | null): ExprPath[] {
  const out: ExprPath[] = [];
  if (!e) return out;
  const walk = (n: QueryExpr, p: ExprPath) => {
    if (n.op === "leaf") out.push(p);
    else if (n.op === "not") walk(n.child, [...p, 0]);
    else n.children.forEach((c, i) => walk(c, [...p, i]));
  };
  walk(e, []);
  return out;
}

/** 视图叶子 id → expr 下标链：两边按 DFS 序配对；未完成叶子不进 expr，跳过以保持对齐。 */
function leafPathMap(viewRoot: VGroup, exprPaths: ExprPath[], circularKeys: ReadonlySet<string>): Map<string, ExprPath> {
  const m = new Map<string, ExprPath>();
  let i = 0;
  const walk = (n: VNode) => {
    if (n.kind === "leaf") {
      if (!isComplete(n.cond, circularKeys)) return;
      if (i < exprPaths.length) m.set(n.id, exprPaths[i]);
      i += 1;
      return;
    }
    n.items.forEach(walk);
  };
  walk(viewRoot);
  return m;
}

/** 连接词分段控件（替代旧的窄下拉，P-e）：radiogroup 语义。 */
function OpSegmented({ value, options, onChange, ariaLabel }: { value: string; options: { value: string; label: string; title: string }[]; onChange: (value: string) => void; ariaLabel: string }) {
  return (
    <span role="radiogroup" aria-label={ariaLabel} className="inline-flex overflow-hidden rounded-md border border-[var(--color-border)]">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={`h-7 px-2 text-[11px] transition-colors ${active ? "bg-[var(--color-accent)]/15 font-medium text-[var(--color-accent)]" : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"}`}
          >
            {o.label}
          </button>
        );
      })}
    </span>
  );
}

const FILTER_OP_OPTIONS: { value: string; label: string; title: string }[] = [
  { value: "and", label: "全部满足", title: "且：组内每项都成立才显示" },
  { value: "or", label: "满足任一", title: "或：组内任一项成立即显示" },
  { value: "minMatch", label: "至少N项", title: "满足至少 N 项才显示" },
];
const MUSTNOT_OP_OPTIONS: { value: string; label: string; title: string }[] = [
  { value: "or", label: "命中任一", title: "或：命中任一条就不显示" },
  { value: "and", label: "全部命中", title: "且：全部命中才不显示" },
];

/** minMatch 的 N 档下拉：1..项数；中间档组合数超上限时禁用（边界 1/全部 恒可用）。 */
function MinSelect({ count, value, onChange, ariaLabel = "至少满足项数" }: { count: number; value: number; onChange: (n: number) => void; ariaLabel?: string }) {
  const total = Math.max(count, 1);
  const clamped = Math.max(1, Math.min(total, value));
  return (
    <span className="flex items-center gap-1 text-[11px] text-[var(--color-text-secondary)]">
      <select aria-label={ariaLabel} value={clamped} onChange={(e) => onChange(Number(e.target.value))} className={`${controlClass} w-14`}>
        {Array.from({ length: total }, (_, i) => i + 1).map((k) => {
          const overCap = k > 1 && k < count && combosCount(count, k) > MAX_MIN_COMBOS;
          return <option key={k} value={k} disabled={overCap} title={overCap ? "组合数过多，请拆分条件组" : undefined}>{k === count ? `${k}（全部）` : k}</option>;
        })}
      </select>
      <span>项</span>
    </span>
  );
}

/** U-6：叶子诊断注记（按 expr 下标链匹配）。delta>0 且 result=0 标红；self_count=0 额外标注。 */
function LeafDiagNoteByPath({ diag, zone, path }: { diag: PlanDiagnostics | null; zone: "filter" | "mustNot"; path?: ExprPath }) {
  const rowDiag = diag && path
    ? diag.leaves.find((l) => l.zone === zone && l.path.length === path.length && path.every((v, i) => l.path[i] === v))
    : undefined;
  return rowDiag ? <LeafDiagNote diag={rowDiag} /> : null;
}

/** U-6：叶子诊断注记本体（P1 收敛）—— 平时不显示裸 ±N；仅当结果被筛到 0 时红字提示。
 *  「该条件单独无匹配」也并入零结果提示，避免界面常驻看不懂的数字。 */
function LeafDiagNote({ diag }: { diag: PlanDiagnostics["leaves"][number] }) {
  const zeroing = diag.delta > 0 && diag.resultCount === 0;
  if (!zeroing) return null;
  const selfEmpty = diag.selfCount === 0;
  return (
    <div className="px-1 pb-1 text-[10px] leading-4 text-[var(--color-danger)]">
      {selfEmpty ? "⚠ 这个条件本身就没有匹配项" : "⚠ 这个条件把结果筛空了，可考虑删除或放宽"}
    </div>
  );
}

/** 递归条件组编辑器：根组直接铺行（不画卡片），子组画浅底圆角卡片并向右缩进一级。
 *  每组底部两个添加入口：+ 条件（加叶子）、+ 条件组（加空子组，默认 AND 并聚焦首行字段）。
 *  行首连接词随组联动：组内第一项「当」，其后按该组 op 显示「并且 / 或者」。 */
/** 拖拽状态：正在被拖的节点 id + 当前悬停的落点（组 id + 组内下标）。 */
type DragState = {
  dndId: string | null;
  dropAt: { groupId: string; index: number } | null;
  setDndId: (id: string | null) => void;
  setDropAt: (at: { groupId: string; index: number } | null) => void;
};

/** 组内下标 i 的落点线（拖拽调层级用；平时零高度不占布局）。 */
function DropLine({ node, index, drag, edit }: { node: VGroup; index: number; drag: DragState; edit: (fn: (root: VGroup) => VGroup) => void }) {
  const active = drag.dndId != null && drag.dropAt?.groupId === node.id && drag.dropAt.index === index;
  if (drag.dndId == null) return <div aria-hidden="true" className="h-0" />;
  return (
    <div
      data-testid="drop-line"
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        drag.setDropAt({ groupId: node.id, index });
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (drag.dndId) edit((r) => moveNodeById(r, drag.dndId!, node.id, index));
        drag.setDndId(null);
        drag.setDropAt(null);
      }}
      className={`-my-0.5 rounded-full transition-all ${active ? "h-2 bg-[var(--color-accent)]/50" : "h-1.5"}`}
    />
  );
}

/** 行首/组头拖拽手柄（P3：行/子组拖拽调层级；整卡不可拖避免干扰输入框选词）。 */
function DragHandle({ item, drag }: { item: VNode; drag: DragState }) {
  const isGroup = item.kind === "group";
  return (
    <span
      draggable
      title={isGroup ? "拖动调整本组位置 / 移入其他组" : "拖动调整顺序 / 移入其他组"}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", item.id);
        drag.setDndId(item.id);
      }}
      onDragEnd={() => {
        drag.setDndId(null);
        drag.setDropAt(null);
      }}
      className={`shrink-0 cursor-grab select-none text-[10px] leading-none text-[var(--color-text-tertiary)] hover:text-[var(--color-text)] ${drag.dndId === item.id ? "opacity-40" : ""}`}
    >
      ⠿
    </span>
  );
}

function GroupEditor({ node, depth, zone, allowGroups, allowMin, allTagOptions, circularKeys, diag, leafPaths, focusLeafId, setFocusLeafId, drag, edit, onMoveCondition }: {
  node: VGroup;
  /** 1 = 区根组（不画卡片） */
  depth: number;
  zone: "filter" | "mustNot";
  allowGroups: boolean;
  allowMin: boolean;
  allTagOptions: FlatTag[];
  circularKeys: ReadonlySet<string>;
  diag: PlanDiagnostics | null;
  leafPaths: Map<string, ExprPath>;
  focusLeafId: string | null;
  setFocusLeafId: (id: string) => void;
  drag: DragState;
  edit: (fn: (root: VGroup) => VGroup) => void;
  onMoveCondition: (to: "filter" | "should" | "mustNot", path: ExprPath) => void;
}) {
  const isCard = depth > 1 || Boolean(node.groupNegated);
  const opValue = node.op === "minMatch" && !allowMin ? "or" : node.op;
  const opOptions = allowMin ? FILTER_OP_OPTIONS : MUSTNOT_OP_OPTIONS;
  const connectorText = node.op === "and" ? "并且" : "或者";
  const dragState: DragState = { dndId: drag.dndId, dropAt: drag.dropAt, setDndId: drag.setDndId, setDropAt: drag.setDropAt };
  const addLeaf = (groupId: string) => {
    const leaf: VLeaf = { kind: "leaf", id: uid(), negated: false, cond: makeCond("tag", allTagOptions) };
    setFocusLeafId(leaf.id);
    edit((r) => addToGroupById(r, groupId, leaf));
  };
  const addGroup = (groupId: string) => {
    // 新子组默认 AND 并自带一条草稿行（自动聚焦其字段），避免空组死胡同（方案 §3.3/§4）
    const leaf: VLeaf = { kind: "leaf", id: uid(), negated: false, cond: makeCond("tag", allTagOptions) };
    setFocusLeafId(leaf.id);
    edit((r) => addToGroupById(r, groupId, { ...emptyGroup(), items: [leaf] }));
  };
  return (
    <div className={isCard ? "rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2" : undefined}>
      {isCard && (
        <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <DragHandle item={node} drag={dragState} />
          <button
            type="button"
            aria-expanded={!node.collapsed}
            aria-label={node.collapsed ? "展开本组" : "收起本组"}
            title={node.collapsed ? "展开本组" : "收起本组"}
            onClick={() => edit((r) => patchGroupById(r, node.id, { collapsed: !node.collapsed }))}
            className="text-[10px] leading-none text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
          >
            {node.collapsed ? "▸" : "▾"}
          </button>
          {node.groupNegated && (
            <span
              title="该组整体取反（NOT）：组内条件可继续编辑，取反本身不提供开关"
              className="rounded bg-[var(--color-danger)]/10 px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-danger)]"
            >
              整组取反
            </span>
          )}
          <OpSegmented
            ariaLabel="子组连接方式"
            value={opValue}
            options={opOptions}
            onChange={(op) => edit((r) => patchGroupById(r, node.id, { op: op as VGroupOp, ...(op === "minMatch" ? { min: defaultMinFor(node.items.length) } : {}) }))}
          />
          {allowMin && opValue === "minMatch" && <MinSelect count={node.items.length} value={node.min} onChange={(n) => edit((r) => patchGroupById(r, node.id, { min: n }))} />}
          <button
            type="button"
            aria-label="删除本组"
            title="删除本组（组内条件一并移除）"
            onClick={() => edit((r) => removeNodeById(r, node.id))}
            className="ml-auto text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-danger)]"
          >
            删除本组
          </button>
        </div>
      )}
      {node.collapsed ? (
        <p className="px-1 py-1 text-[11px] text-[var(--color-text-tertiary)]">已收起：{countNodeLeaves(node)} 项条件</p>
      ) : node.items.length === 0 ? (
        depth === 1 ? (
          <div className="flex gap-2">
            <button
              id={zone === "filter" ? "qb-must-add" : undefined}
              type="button"
              onClick={() => addLeaf(node.id)}
              className="flex h-10 flex-1 items-center justify-center border border-dashed border-[var(--color-border)] text-xs text-[var(--color-text-secondary)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
            >
              {zone === "filter" ? "+ 添加第一个条件" : "+ 添加第一个排除条件"}
            </button>
            {allowGroups && depth < MAX_GROUP_DEPTH && (
              <button
                type="button"
                onClick={() => addGroup(node.id)}
                className="flex h-10 items-center justify-center border border-dashed border-[var(--color-border)] px-3 text-xs text-[var(--color-text-secondary)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
              >
                + 条件组
              </button>
            )}
          </div>
        ) : (
          <p className="px-1 py-1 text-[11px] text-[var(--color-text-tertiary)]">空条件组：点下方「+ 条件」添加第一项</p>
        )
      ) : (
        <div className="flex flex-col">
          <DropLine node={node} index={0} drag={dragState} edit={edit} />
          {node.items.map((item, index) => (
            <Fragment key={item.id}>
              {item.kind === "leaf" ? (
                <div>
                  <ConditionRow
                    row={item}
                    dragHandle={<DragHandle item={item} drag={dragState} />}
                    autoFocus={item.id === focusLeafId}
                    prefix={index === 0 ? "当" : connectorText}
                    allTagOptions={allTagOptions}
                    zone={zone}
                    onMove={(t) => onMoveCondition(t, leafPaths.get(item.id) ?? [])}
                    onChange={(patch) => edit((r) => replaceNodeById(r, item.id, { ...item, ...patch }))}
                    onRemove={() => edit((r) => removeNodeById(r, item.id))}
                  />
                  <LeafDiagNoteByPath diag={diag} zone={zone} path={leafPaths.get(item.id)} />
                </div>
              ) : (
                <div>
                  {index > 0 && (
                    <div className="mb-1 pl-1">
                      <span className="rounded-full bg-[var(--color-surface-hover)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">{connectorText}</span>
                    </div>
                  )}
                  <div className="pl-2">
                    <GroupEditor
                      node={item}
                      depth={depth + 1}
                      zone={zone}
                      allowGroups={allowGroups}
                      allowMin={allowMin}
                      allTagOptions={allTagOptions}
                      circularKeys={circularKeys}
                      diag={diag}
                      leafPaths={leafPaths}
                      focusLeafId={focusLeafId}
                      setFocusLeafId={setFocusLeafId}
                      drag={dragState}
                      edit={edit}
                      onMoveCondition={onMoveCondition}
                    />
                  </div>
                </div>
              )}
              <DropLine node={node} index={index + 1} drag={dragState} edit={edit} />
            </Fragment>
          ))}
        </div>
      )}
      {/* 底部添加入口：空子组也能加第一项（否则空组成死胡同）；折叠时不显示 */}
      {!node.collapsed && (node.items.length > 0 || depth > 1) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <button
            id={depth === 1 && zone === "filter" ? "qb-must-add" : undefined}
            type="button"
            onClick={() => addLeaf(node.id)}
            className="h-8 px-1 text-xs font-medium text-[var(--color-status)] hover:opacity-80"
          >
            {zone === "filter" ? "+ 添加条件" : "＋ 添加排除条件"}
          </button>
          {allowGroups && depth < MAX_GROUP_DEPTH && (
            <button type="button" onClick={() => addGroup(node.id)} className="h-8 px-1 text-xs font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text)]">+ 条件组</button>
          )}
          {allowGroups && depth >= MAX_GROUP_DEPTH && <span className="text-[11px] text-[var(--color-text-tertiary)]">层级已足够，可拆分搜索</span>}
        </div>
      )}
    </div>
  );
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

function ConditionRow({ row, prefix, allTagOptions, zone, autoFocus = false, dragHandle, onMove, onChange, onRemove }: { row: VLeaf; prefix: string; allTagOptions: FlatTag[]; zone: "filter" | "mustNot"; autoFocus?: boolean; dragHandle?: React.ReactNode; onMove: (to: "filter" | "should" | "mustNot") => void; onChange: (patch: Partial<VLeaf>) => void; onRemove: () => void }) {
  const field = fieldFromCond(row.cond);
  // P1 硬规则：一条条件严格只占一行 —— 连接词｜字段｜（数值类才有的）运算符｜值｜移动｜删除，同一水平线。
  const needsOperator = leafNeedsOperator(row.cond);
  return (
    <div className="flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-1.5">
      {dragHandle}
      <span className="w-6 shrink-0 text-[11px] text-[var(--color-text-tertiary)]">{prefix}</span>
      <div className="w-[104px] shrink-0"><FieldSelect value={field} autoFocus={autoFocus} onChange={(next) => onChange({ cond: makeCond(next, allTagOptions), negated: false })} /></div>
      {needsOperator && <div className="w-[76px] shrink-0"><ConditionOperator cond={row.cond} negated={row.negated} onChange={onChange} /></div>}
      {row.negated && <span title="该条件取反（NOT）" className="shrink-0 rounded bg-[var(--color-danger)]/10 px-1 text-[11px] text-[var(--color-danger)]">非</span>}
      <div className="min-w-0 flex-1"><ConditionValue cond={row.cond} allTagOptions={allTagOptions} onChange={(cond) => onChange({ cond })} /></div>
      <MoveMenu zone={zone} onMove={onMove} />
      <button type="button" onClick={onRemove} className="flex size-7 shrink-0 items-center justify-center rounded text-base text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-danger)]" aria-label="删除条件" title="删除条件">×</button>
    </div>
  );
}
function FieldSelect({ value, onChange, hideKeys = [], autoFocus = false }: { value: FieldKey; onChange: (value: FieldKey) => void; hideKeys?: FieldKey[]; autoFocus?: boolean }) {
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

  // 「+ 条件 / + 条件组」新行自动聚焦字段下拉（方案 §3.3）
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

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

/** 是否需要独立运算符格：仅数值/元数据类字段需要显式运算符（等于/大于/介于…）。
 *  标签/关键词/素材类型/未打标/分面有无 —— 字段名本身已含语义，严格一行时不占运算符格（P1 减负）。 */
function leafNeedsOperator(cond: LeafCond): boolean {
  return cond.type === "metadata" || cond.type === "facetNumber";
}

// ═════════ P1：实时人话预览 —— 把条件树/优先项翻译成一句中文，未完成条件自动跳过 ═════════
function briefScalar(v: unknown): string {
  if (v == null || v === "") return "…";
  return String(v);
}
function metadataValueBrief(filter: MetadataFilter): string {
  if (filter.op === "between") return `${briefScalar(filter.min)}~${briefScalar(filter.max)}`;
  if (filter.op === "in") return (filter.values ?? []).map(briefScalar).join("、") || "…";
  return briefScalar(filter.value);
}
/** 单个叶子条件 → 简短中文（用于底部预览句）。 */
function leafBrief(cond: LeafCond, tags: FlatTag[]): string {
  switch (cond.type) {
    case "tag":
    case "excludeTag": {
      const byId = new Map(tags.map((t) => [t.id, t.name]));
      const names = cond.tagIds.map((id) => byId.get(id) ?? `#${id}`);
      return `标签 ${names.join("、") || "…"}`;
    }
    case "search":
      return `关键词“${cond.value || "…"}”`;
    case "assetType":
      return `素材类型${cond.value === "image" ? "图片" : cond.value === "video" ? "视频" : "全部"}`;
    case "untagged":
      return "未打标";
    case "facetHasAny":
      return `${cond.facetKey}分类有标签`;
    case "facetMissing":
      return `${cond.facetKey}分类无标签`;
    case "facetNumber":
      return `${cond.facetKey} ${OP_LABELS[cond.op]} ${cond.value}${cond.op === "between" ? `~${cond.maxValue ?? ""}` : ""}`;
    case "metadata": {
      const label = FIELD_OPTIONS.find((o) => o.key === cond.filter.key)?.label ?? cond.filter.key;
      return `${label} ${OP_LABELS[cond.filter.op] ?? cond.filter.op} ${metadataValueBrief(cond.filter)}`;
    }
    default:
      return "";
  }
}
/** 条件组 → 中文（且/或/至少N项；子组加括号；未完成叶子跳过；整组无完成项返回空串）。 */
function groupBrief(node: VNode, tags: FlatTag[], circularKeys: ReadonlySet<string>): string {
  if (node.kind === "leaf") {
    return isComplete(node.cond, circularKeys) ? leafBrief(node.cond, tags) : "";
  }
  const parts = node.items
    .map((it) => (it.kind === "group" ? `（${groupBrief(it, tags, circularKeys)}）` : groupBrief(it, tags, circularKeys)))
    .filter(Boolean);
  if (parts.length === 0) return "";
  const core = node.op === "and" ? parts.join(" 且 ") : node.op === "or" ? parts.join(" 或 ") : `[${parts.join("、")}]中至少${node.min}项`;
  return node.groupNegated ? `非（${core}）` : core;
}
function ConditionOperator({ cond, negated, onChange }: { cond: LeafCond; negated: boolean; onChange: (patch: Partial<VLeaf>) => void }) {
  // P1：标签/关键词/枚举/分面有无不再渲染只读「是/存在/缺失」占位（字段名已表达）。
  // 仅数值类保留真正的运算符下拉；遗留 NOT(leaf) 由 ConditionRow 在行内以「非」角标兜底，防止静默改义。
  void negated;
  if (cond.type === "facetNumber") return <select aria-label="条件操作符" value={cond.op} onChange={(e) => onChange({ cond: changeFacetNumberOp(cond, e.target.value as FacetNumberOp) })} className={`${controlClass} w-full`}>{NUMERIC_OPS.map((op) => <option key={op} value={op}>{OP_LABELS[op]}</option>)}</select>;
  if (cond.type === "metadata") { const ops = FIELD_OPTIONS.find((item) => item.key === cond.filter.key)?.ops ?? NUMERIC_OPS; return <select aria-label="条件操作符" value={cond.filter.op} onChange={(e) => onChange({ cond: { ...cond, filter: changeMetadataOp(cond.filter, e.target.value as MetadataOp) } })} className={`${controlClass} w-full`}>{ops.map((op) => <option key={op} value={op}>{OP_LABELS[op]}</option>)}</select>; }
  return null;
}

function ConditionValue({ cond, allTagOptions, onChange }: { cond: LeafCond; allTagOptions: FlatTag[]; onChange: (cond: LeafCond) => void }) {
  const numericDomains = useNumericDomainStore((s) => s.domains);
  if (cond.type === "facetNumber") {
    // V24（Phase 7-8）：数值分面值输入 —— 单值走 ValueInput（单位/预设/clamp 全来自 domain）；
    // between 两输入共用同一 domain（同一单位，§5.4）
    const domain = numericDomains.find((d) => d.key === `${FACET_FIELD_PREFIX}${cond.facetKey}`);
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
    // P1：标签值就是「已选 chip ＋ 选择按钮」一行；范围/按词查全部收进浮层「高级」。
    return (
      <TagValueCell
        isExclude={cond.type === "excludeTag"}
        data={data}
        options={options}
        onChange={(next) => onChange((cond.type === "tag"
          ? { ...cond, facetKey: next.facetKey, tagIds: next.tagIds, mode: next.mode, includeDescendants: next.includeDescendants, termQuery: next.termQuery, termMatch: next.termMatch }
          : { ...cond, facetKey: next.facetKey, tagIds: next.tagIds }) as LeafCond)}
      />
    );
  }
  return <MetadataValue filter={cond.filter} onChange={(filter) => onChange({ ...cond, filter })} />;
}

/** P1 标签值单元格（极简一行）：主行 = 已选 chip（可单个移除）+「＋选择」按钮 + AI 按词查回显小胶囊。
 *  点「选择」弹出 portal 浮层（不撑高行、不被裁切、点外部/完成关闭）：搜索勾选 + 底部默认收起的「高级」
 *  （同时匹配子级标签 / 多标签命中任一·全部 / 按词查）。主行不再出现含子标签、按词查、匹配模式等任何控件。 */
function TagValueCell({ isExclude, data, options, onChange }: { isExclude: boolean; data: TagCondData; options: FlatTag[]; onChange: (next: TagCondData) => void }) {
  const [open, setOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [q, setQ] = useState("");
  // 面板过滤匹配模式（默认别名）；同时作为按词查 termMatch（与既有 S5 双向语义一致）
  const [match, setMatch] = useState<TermMatchKey>(data.termMatch ?? DEFAULT_TERM_MATCH);
  const [term, setTerm] = useState<string>(data.termQuery ?? "");
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; width: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  // 浮层 portal 到 body、不在 rootRef 内，外部点击判断需同时排除浮层本身，否则一点勾选就被关掉
  const panelRef = useRef<HTMLDivElement>(null);
  const portalHost = useRef<HTMLDivElement | null>(null);
  useEffect(() => { const host = document.createElement("div"); document.body.appendChild(host); portalHost.current = host; return () => { host.remove(); }; }, []);
  useEffect(() => { setMatch(data.termMatch ?? DEFAULT_TERM_MATCH); }, [data.termMatch]);
  useEffect(() => { setTerm(data.termQuery ?? ""); }, [data.termQuery]);
  /** 按词查写进条件（词 + 模式）。词清空 → 移除 termQuery（回到纯 chip 语义）。 */
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
  // 浮层锚定到「选择」按钮（空间不足向上翻转，避免贴出视口右边界）
  const measure = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const W = 288;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - W - 8));
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const flipUp = below < 260 && above > below;
    setPos({ left, width: W, ...(flipUp ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }) });
  }, []);
  useEffect(() => {
    if (!open) return;
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, measure]);
  const panelStyle: React.CSSProperties | undefined = pos
    ? { position: "fixed", left: pos.left, width: pos.width, zIndex: 60, ...(pos.top != null ? { top: pos.top } : { bottom: pos.bottom }) }
    : undefined;
  return (
    <div ref={rootRef} className="flex min-w-0 flex-wrap items-center gap-1">
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
      <button ref={btnRef} type="button" aria-expanded={open} aria-label="选择标签" onClick={() => setOpen((o) => !o)} className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-dashed border-[var(--color-border-strong)] px-2 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]">＋ {data.tagIds.length > 0 ? "添加" : "选择标签"}</button>
      {/* AI 回填的按词查：主行仅以可删小胶囊回显，不常驻输入框 */}
      {!isExclude && data.termQuery && data.termQuery.trim() && (
        <span data-testid="term-query-chip" className="inline-flex h-6 items-center gap-1 rounded-full bg-[var(--color-surface-hover)] px-2 text-[10px] text-[var(--color-text-secondary)]">
          词：{data.termQuery.trim()}
          <button type="button" aria-label="移除按词查" title="移除按词查" onClick={() => onChange({ ...data, termQuery: null })} className="text-[var(--color-text-secondary)] hover:text-[var(--color-danger)]">×</button>
        </span>
      )}
      {open && portalHost.current && createPortal(
        <div ref={panelRef} className="overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] shadow-lg" style={panelStyle}>
          <div className="flex items-center gap-1.5 border-b border-[var(--color-border)] p-1.5">
            <input autoFocus aria-label="搜索标签" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索标签…" className="ui-control h-7 min-w-0 flex-1 px-2 text-xs" />
            <select aria-label="匹配模式" title="面板标签过滤方式" value={match} onChange={(e) => setMatch(e.target.value as TermMatchKey)} className={`${controlClass} w-[68px] shrink-0`}>{TERM_MATCH_KEYS.map((k) => <option key={k} value={k}>{TERM_MATCH_LABELS[k]}</option>)}</select>
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
          {!isExclude && (
            <div className="border-t border-[var(--color-border)]">
              <button type="button" onClick={() => setAdvanced((v) => !v)} className="flex w-full items-center justify-between px-3 py-1.5 text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]">
                <span>高级：子级标签 / 多标签关系 / 按词查</span>
                <span aria-hidden="true">{advanced ? "▾" : "▸"}</span>
              </button>
              {advanced && (
                <div className="space-y-2 px-3 pb-2.5 text-[11px] text-[var(--color-text-secondary)]">
                  <label className="flex cursor-pointer items-center gap-1.5" title="选中父标签时，自动把其子孙标签也算命中（默认开启）">
                    <input
                      type="checkbox"
                      checked={data.includeDescendants && data.mode !== "all"}
                      disabled={data.mode === "all"}
                      onChange={(e) => onChange({ ...data, mode: "any", includeDescendants: e.target.checked })}
                      className="accent-[var(--color-accent)]"
                    />
                    同时匹配子级标签
                  </label>
                  <div className="flex items-center gap-1.5">
                    <span className="shrink-0">多个标签</span>
                    <select
                      aria-label="多标签关系"
                      value={data.mode}
                      onChange={(e) => { const mode = e.target.value as "any" | "all"; onChange({ ...data, mode, includeDescendants: mode === "all" ? false : data.includeDescendants }); }}
                      className={`${controlClass} h-7 flex-1`}
                    >
                      <option value="any">命中任一即可</option>
                      <option value="all">全部命中</option>
                    </select>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <DraftInput ariaLabel="按词查" placeholder="按词查（可选）" displayValue={term} onCommit={(v) => commitTerm(v, match)} className={`${controlClass} min-w-0 flex-1`} />
                  </div>
                </div>
              )}
            </div>
          )}
          <div className="flex justify-end border-t border-[var(--color-border)] p-1">
            <button type="button" onClick={() => setOpen(false)} className="rounded px-2 py-1 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]">完成</button>
          </div>
        </div>,
        portalHost.current,
      )}
    </div>
  );
}
function MetadataValue({ filter, onChange }: { filter: MetadataFilter; onChange: (filter: MetadataFilter) => void }) {
  const numericDomains = useNumericDomainStore((s) => s.domains);
  const metadataFacets = useMetadataStore((s) => s.facets);
  // U-3：前三色走色块选择器（单选 eq + 占比阈值 / 多选 in）
  if (filter.key === "palette_top3") return <PaletteValue filter={filter} onChange={onChange} />;
  // Phase 4（§5.3）：数值字段的 min/max/step/后缀/预设/环形全部来自 NumericDomain（单一事实源）。
  const domain = numericDomains.find((d) => d.key === filter.key);
  const facetItems = metadataFacets.find((f) => f.key === filter.key)?.items;
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
