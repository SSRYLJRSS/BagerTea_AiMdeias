/** Phase 1/2 执行契约 §4.1a / §4.8：ResolvedSearchQuery → SearchPlanV3 与 AI「追加模式」合并。
 *  这些是纯函数 —— 与后端 db/search_plan.rs 的 validate/prune/compile 语义逐条对齐，
 *  契约测试（35 条中约 7 条 TS 侧）直接对它们断言。 */
import type { ResolvedSearchQuery } from "@/types/asset";
import type { LeafCond, QueryExpr } from "@/types/queryExpr";
import type {
  PlanWarningSource,
  Ranking,
  SearchPlanV3,
  SearchWarning,
  ShouldClause,
} from "@/types/superSearch";

/** S6：版本常量（与后端 db/search_plan.rs 单点声明对齐）。 */
export const PLAN_SCHEMA_VERSION = 3;
export const NORMALIZATION_VERSION = 1;
export const COMPILER_VERSION = 1;
/** S1：加分条数上限。 */
export const MAX_SHOULD_CLAUSES = 12;

export function fieldRanking(key: string, dir: string): Ranking {
  return { type: "field", key, dir: dir === "asc" ? "asc" : "desc" };
}

function leaf(cond: LeafCond): QueryExpr {
  return { op: "leaf", cond };
}

function andOf(leaves: QueryExpr[]): QueryExpr | null {
  if (leaves.length === 0) return null;
  if (leaves.length === 1) return leaves[0];
  return { op: "and", children: leaves };
}

function orOf(leaves: QueryExpr[]): QueryExpr | null {
  if (leaves.length === 0) return null;
  if (leaves.length === 1) return leaves[0];
  return { op: "or", children: leaves };
}

function defaultPlan(filter: QueryExpr | null, mustNot: QueryExpr | null, ranking: Ranking): SearchPlanV3 {
  return {
    planSchemaVersion: PLAN_SCHEMA_VERSION,
    normalizationVersion: NORMALIZATION_VERSION,
    compilerVersion: COMPILER_VERSION,
    filter,
    mustNot,
    should: [],
    minimumShouldMatch: 0,
    retrievers: { retrievers: [], fusion: "rrf" },
    ranking,
  };
}

/** §4.1a：扁平查询 → SearchPlanV3。
 *  - 正向条件（search/assetType/untagged/facetFilters/metadata）→ plan.filter（多叶子 AND）
 *  - excludeTagIds → mustNot 里的**正向 Tag**（不是 excludeTag）；多条 → Or
 *  - sortBy/sortDir → ranking（B9：字段主键 + score 次级由后端保证）
 */
export function resolvedQueryToPlan(q: ResolvedSearchQuery): SearchPlanV3 {
  const filterLeaves: QueryExpr[] = [];
  if (q.search.trim()) filterLeaves.push(leaf({ type: "search", value: q.search.trim() }));
  if (q.assetType !== "all") filterLeaves.push(leaf({ type: "assetType", value: q.assetType }));
  if (q.untaggedOnly) filterLeaves.push(leaf({ type: "untagged" }));
  for (const f of q.facetFilters) {
    if (f.tagIds.length === 0) continue;
    filterLeaves.push(
      leaf({
        type: "tag",
        facetKey: f.facetKey,
        tagIds: f.tagIds,
        mode: f.mode ?? "any",
        includeDescendants: f.includeDescendants,
      }),
    );
  }
  for (const m of q.metadataFilters) filterLeaves.push(leaf({ type: "metadata", filter: m }));
  // 排除：正向 Tag 进 mustNot（P0 极性：mustNot 只放正向条件，统一由计划层包 NOT）
  const exclusionLeaves = q.excludeTagIds.map((tagId) =>
    leaf({ type: "tag", facetKey: "", tagIds: [tagId], mode: "any", includeDescendants: true }),
  );
  return defaultPlan(
    andOf(filterLeaves),
    orOf(exclusionLeaves),
    fieldRanking(q.sortBy ?? "created_at", q.sortDir ?? "desc"),
  );
}

/** 纯叶子序列化（稳定 key 顺序由构造方保证）。 */
export function serializeCond(c: LeafCond): string {
  return JSON.stringify(c);
}

export function warning(source: PlanWarningSource, message: string, zone?: SearchWarning["zone"]): SearchWarning {
  return { source, message, ...(zone ? { zone } : {}) };
}

function exprKey(child: QueryExpr): string {
  return child.op === "leaf" ? serializeCond(child.cond) : JSON.stringify(child);
}

/** §4.8：filter 按 AND 合并（保留内部 OR/AND 分组），按序列化去重相同叶子。 */
function andMerge(a: QueryExpr | null, b: QueryExpr | null): QueryExpr | null {
  if (!a) return b;
  if (!b) return a;
  const seen = new Set<string>();
  const children: QueryExpr[] = [];
  for (const child of [...(a.op === "and" ? a.children : [a]), ...(b.op === "and" ? b.children : [b])]) {
    const key = exprKey(child);
    if (seen.has(key)) continue;
    seen.add(key);
    children.push(child);
  }
  return andOf(children);
}

/** §4.8：mustNot 按 OR 合并（任一命中即排除），同样去重。 */
function orMerge(a: QueryExpr | null, b: QueryExpr | null): QueryExpr | null {
  if (!a) return b;
  if (!b) return a;
  const seen = new Set<string>();
  const children: QueryExpr[] = [];
  for (const child of [...(a.op === "or" ? a.children : [a]), ...(b.op === "or" ? b.children : [b])]) {
    const key = exprKey(child);
    if (seen.has(key)) continue;
    seen.add(key);
    children.push(child);
  }
  return orOf(children);
}

/** §4.8：AI「追加模式」合并 —— replace 与 append 只差 ranking/retrievers。 */
export function appendPlanMerge(
  base: SearchPlanV3,
  incoming: SearchPlanV3,
): { plan: SearchPlanV3; warnings: SearchWarning[] } {
  const warnings: SearchWarning[] = [];
  // filter：AND 合并（保留内部 OR）
  const filter = andMerge(base.filter, incoming.filter);
  // mustNot：OR 合并
  const mustNot = orMerge(base.mustNot, incoming.mustNot);
  // should：拼接 + 去重 + 超 12 按权重降序保留前 12
  const seen = new Set<string>();
  const merged: ShouldClause[] = [];
  for (const sc of [...base.should, ...incoming.should]) {
    const key = serializeCond(sc.cond);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(sc);
  }
  const dropped = merged.length - MAX_SHOULD_CLAUSES;
  let should = merged;
  if (dropped > 0) {
    should = [...merged].sort((x, y) => y.weight - x.weight).slice(0, MAX_SHOULD_CLAUSES);
    warnings.push(
      warning("plan", `加分项超过 ${MAX_SHOULD_CLAUSES} 条，已保留权重较高的 ${MAX_SHOULD_CLAUSES} 条。`, "should"),
    );
  }
  // minimumShouldMatch：old.should 非空时保持用户值；最后 clamp(0, len)
  const rawMin = base.should.length > 0 ? base.minimumShouldMatch : incoming.minimumShouldMatch;
  const minimumShouldMatch = Math.max(0, Math.min(should.length, Math.floor(rawMin)));
  if (base.should.length > 0 && minimumShouldMatch !== base.minimumShouldMatch) {
    warnings.push(
      warning("plan", `『至少满足 N 项』已收敛为 ${minimumShouldMatch}。`, "should"),
    );
  }
  // ranking：append 恒保留用户的；AI 建议不同 → 提示
  if (JSON.stringify(base.ranking) !== JSON.stringify(incoming.ranking)) {
    warnings.push(warning("plan", "AI 建议的排序方式未被采纳（追加模式保留当前排序）。"));
  }
  const plan: SearchPlanV3 = {
    ...defaultPlan(filter, mustNot, base.ranking),
    should,
    minimumShouldMatch,
    // retrievers：append 保留旧的；AI 的不同 → 提示
    retrievers:
      JSON.stringify(base.retrievers) === JSON.stringify(incoming.retrievers)
        ? base.retrievers
        : (warnings.push(warning("plan", "AI 建议的召回方式未被采纳（追加模式保留当前召回）。")), base.retrievers),
    ranking: base.ranking,
  };
  return { plan, warnings };
}

/** §3.7/§4.8：排除区 OR 合并的公开入口（store 的 moveConditionBetweenZones 等使用）。 */
export function mergeMustNotExpr(a: QueryExpr | null, b: QueryExpr | null): QueryExpr | null {
  return orMerge(a, b);
}

/** §4.4：plan 版本迁移（store hydrate 无条件执行；未来版本 → null 丢弃）。 */
export function migratePlanV3(plan: SearchPlanV3): SearchPlanV3 | null {
  if (plan.planSchemaVersion > PLAN_SCHEMA_VERSION || plan.normalizationVersion > NORMALIZATION_VERSION) {
    return null;
  }
  return {
    ...plan,
    planSchemaVersion: PLAN_SCHEMA_VERSION,
    normalizationVersion: NORMALIZATION_VERSION,
    compilerVersion: COMPILER_VERSION,
  };
}
