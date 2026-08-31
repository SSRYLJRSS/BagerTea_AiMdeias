/** 标签树状态：树数据 + 展开节点 + 选中筛选 */
import { create } from "zustand";
import { listTagFacets, listTags, listTagsByFacet, searchTagCandidates } from "@/api/tags";
import type { Tag, TagFacet, TagNode, WorkbenchFacet } from "@/types/tag";
import type { AiFacetConfig } from "@/types/settings";

interface TagState {
  tree: TagNode[];
  facets: TagFacet[];
  treesByFacet: Record<string, TagNode[]>;
  candidates: Tag[];
  loading: boolean;
  expanded: ReadonlySet<number>;
  refresh: () => Promise<void>;
  refreshFacet: (facetKey: string) => Promise<void>;
  searchCandidates: (facetKey: string | null, query: string) => Promise<void>;
  toggleExpand: (id: number) => void;
  /** FB6 需求四：全部展开（收集树中所有拥有子节点的节点，不只当前一层） */
  expandAll: () => void;
  /** FB6 需求四：全部收起 */
  collapseAll: () => void;
}

export const useTagStore = create<TagState>((set) => ({
  tree: [],
  facets: [],
  treesByFacet: {},
  candidates: [],
  loading: false,
  expanded: new Set<number>(),

  refresh: async () => {
    set({ loading: true });
    try {
      const [tree, facets] = await Promise.all([listTags(), listTagFacets()]);
      // 首次加载默认展开顶级（有子的）
      set((s) => ({
        tree,
        facets,
        treesByFacet: Object.fromEntries(
          facets.map((facet) => [facet.key, tree.filter((node) => node.tag.facetKey === facet.key)]),
        ),
        loading: false,
        expanded: s.expanded.size === 0 ? collectDefaultExpanded(tree) : s.expanded,
      }));
    } catch {
      set({ loading: false });
    }
  },

  refreshFacet: async (facetKey) => {
    const tree = await listTagsByFacet(facetKey);
    set((s) => ({ treesByFacet: { ...s.treesByFacet, [facetKey]: tree } }));
  },

  searchCandidates: async (facetKey, query) => {
    if (!query.trim()) {
      set({ candidates: [] });
      return;
    }
    set({ candidates: await searchTagCandidates(facetKey, query) });
  },

  toggleExpand: (id) =>
    set((s) => {
      const next = new Set(s.expanded);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { expanded: next };
    }),

  expandAll: () =>
    set((s) => ({ expanded: collectExpandableIds(s.tree) })),

  collapseAll: () => set({ expanded: new Set<number>() }),
}));

function collectDefaultExpanded(tree: TagNode[]): ReadonlySet<number> {
  return new Set(tree.filter((n) => n.children.length > 0).map((n) => n.tag.id));
}

/** 递归收集所有拥有子节点的节点 id（FB6 需求四：expandAll 覆盖全部层级，不只顶级） */
function collectExpandableIds(nodes: TagNode[]): ReadonlySet<number> {
  const ids = new Set<number>();
  const walk = (list: TagNode[]) => {
    for (const n of list) {
      if (n.children.length > 0) {
        ids.add(n.tag.id);
        walk(n.children);
      }
    }
  };
  walk(nodes);
  return ids;
}

/** 固定基础分面（指导书 §9.3）：即使当前素材无标签、AI 无建议、手动模式，也必须显示这些系统分面。 */
const BASE_FACET_DEFAULTS: Record<string, { displayName: string; description: string; selectionMode: "single" | "multi"; maxItems: number | null }> = {
  subject: { displayName: "主体/对象", description: "画面的主体或对象", selectionMode: "multi", maxItems: 5 },
  scene: { displayName: "场景/地点", description: "拍摄的场景或地点", selectionMode: "multi", maxItems: 5 },
  purpose: { displayName: "用途", description: "素材用途/应用场景", selectionMode: "multi", maxItems: 5 },
  style: { displayName: "风格/氛围", description: "视觉风格/氛围", selectionMode: "multi", maxItems: 5 },
  color: { displayName: "色彩", description: "色彩基调", selectionMode: "multi", maxItems: 5 },
  composition: { displayName: "构图/视角", description: "构图或拍摄视角", selectionMode: "multi", maxItems: 5 },
  lighting: { displayName: "光线/时间", description: "光线条件或拍摄时间", selectionMode: "multi", maxItems: 5 },
  people: { displayName: "人物属性", description: "人物相关属性", selectionMode: "multi", maxItems: 5 },
  technical: { displayName: "可用性/技术特征", description: "技术/可用性特征", selectionMode: "multi", maxItems: 5 },
  custom: { displayName: "自定义", description: "自由标签", selectionMode: "multi", maxItems: null },
};
const BASE_FACET_KEYS = Object.keys(BASE_FACET_DEFAULTS);

/** C-1：工作台默认显示的用户要求分面白名单（集中定义，不在多个组件中分别过滤）。
 *  purpose / technical / custom 默认隐藏（只影响工作台显示，不影响历史标签/搜索/数据库）。 */
export const WORKBENCH_DEFAULT_KEYS = [
  "subject",
  "scene",
  "style",
  "color",
  "composition",
  "lighting",
  "people",
] as const;

/** 中文分类显示名 → 稳定 facetKey（与后端 key_for_legacy_name 对齐）。未知归 custom。 */
export function keyForLegacyName(name: string): string {
  const n = name.trim();
  const map: Record<string, string> = {
    subject: "subject", scene: "scene", purpose: "purpose", style: "style", color: "color",
    composition: "composition", lighting: "lighting", people: "people", technical: "technical", custom: "custom",
    "主体": "subject", "主体/对象": "subject", "物体": "subject",
    "场景": "scene", "场景/地点": "scene",
    "用途": "purpose", "用途/项目类型": "purpose",
    "风格": "style", "风格/氛围": "style", "色彩风格": "style", "氛围情绪": "style",
    "色彩": "color", "色调": "color",
    "构图": "composition", "构图视角": "composition", "构图/视角": "composition",
    "光线": "lighting", "时间": "lighting", "光线/时间": "lighting", "光线/时间氛围": "lighting",
    "人物": "people", "人物属性": "people", "人物/主体属性": "people",
    "技术": "technical", "可用性/技术特征": "technical",
  };
  return map[n] ?? "custom";
}

/** 分面是否显示在工作台：
 *  - 显式设置了 visibleInWorkbench → 以配置为准；
 *  - 未设置 → 基础分面按 WORKBENCH_DEFAULT_KEYS 白名单；非基础分面（用户自建）默认显示。 */
function isVisibleInWorkbench(key: string, cfg?: AiFacetConfig): boolean {
  if (cfg?.visibleInWorkbench !== undefined) return cfg.visibleInWorkbench;
  return BASE_FACET_KEYS.includes(key) ? (WORKBENCH_DEFAULT_KEYS as readonly string[]).includes(key) : true;
}

/** 组装工作台分面（指导书 §9.2/§9.3 + C-1/C-2）：
 *  - tag_facets 唯一决定结构与默认显示名/描述/single/max；
 *  - aiFacetConfigs 只覆盖 enabledForAi / hint / 可选显示名（displayName）/ 工作台显隐（visibleInWorkbench）；
 *  - 只返回「工作台可见」的分面（purpose/technical/custom 默认隐藏）。 */
export function buildWorkbenchFacets(facets: TagFacet[], configs: AiFacetConfig[]): WorkbenchFacet[] {
  const configByKey = new Map(configs.map((c) => [c.facetKey, c]));
  const byKey = new Map(facets.map((f) => [f.key, f]));
  const out: WorkbenchFacet[] = [];
  // 基础分面按白名单顺序在前（§9.3）
  for (const key of BASE_FACET_KEYS) {
    if (!isVisibleInWorkbench(key, configByKey.get(key))) continue;
    const f = byKey.get(key);
    const cfg = configByKey.get(key);
    const base = BASE_FACET_DEFAULTS[key];
    out.push({
      key,
      displayName: cfg?.displayName?.trim() || f?.displayName || base.displayName,
      description: f?.description || base.description,
      selectionMode: f?.selectionMode ?? base.selectionMode,
      maxItems: f?.maxItems ?? base.maxItems,
      enabledForAi: cfg?.enabledForAi ?? true,
      hint: cfg?.hint ?? "",
    });
  }
  // 额外存在于 DB 但非基础分面的分面也保留（如自定义扩展）
  for (const key of byKey.keys()) {
    if (BASE_FACET_KEYS.includes(key)) continue;
    if (!isVisibleInWorkbench(key, configByKey.get(key))) continue;
    const f = byKey.get(key)!;
    const cfg = configByKey.get(key);
    out.push({
      key,
      displayName: cfg?.displayName?.trim() || f.displayName,
      description: f.description,
      selectionMode: f.selectionMode,
      maxItems: f.maxItems,
      enabledForAi: cfg?.enabledForAi ?? true,
      hint: cfg?.hint ?? "",
    });
  }
  return out;
}

/** 把 AI/素材返回的分类标签 key 归一化为稳定 facetKey（未知 → custom），
 *  供工作台用稳定 key 渲染与回写（指导书 §9.4/§9.5）。 */
export function normalizeTagKeys(tags: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, list] of Object.entries(tags)) {
    const key = keyForLegacyName(name);
    out[key] = [...(out[key] ?? []), ...list];
  }
  return out;
}

/** 扁平化遍历（标签树渲染用） */
export function flattenVisible(
  tree: TagNode[],
  expanded: ReadonlySet<number>,
  depth = 0,
): { node: TagNode; depth: number }[] {
  const out: { node: TagNode; depth: number }[] = [];
  for (const node of tree) {
    out.push({ node, depth });
    if (expanded.has(node.tag.id)) out.push(...flattenVisible(node.children, expanded, depth + 1));
  }
  return out;
}
