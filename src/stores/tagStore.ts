/** 标签树状态：树数据 + 展开节点 + 选中筛选 */
import { create } from "zustand";
import { listTagFacets, listTags, listTagsByFacet, searchTagCandidates } from "@/api/tags";
import type { Tag, TagFacet, TagNode, WorkbenchFacet } from "@/types/tag";

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

/** W3-2：中文分类显示名 → 稳定 facetKey。
 *  【降级保留】只在解析历史 CategorizedTags JSON 时用（老数据确实存着中文 key）。
 *  新链路禁止调用——分面 key 路由必须走后端 resolve_facet_key（W2-10），
 *  它会查 DB 让自建分面生效；这里查不到自建分面。 */
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

/** W3-2 重写：工作台分面分组 —— 遍历后端 facets（不再是前端常量白名单），
 *  按 inputMode 分成「AI 识别」与「需要你填」两组，并消费 appliesTo（此前前端完全没用）。
 *  DB 空时返回空数组（不回退硬编码默认值——用户改了 DB 值前端必须跟随）。 */
export function buildWorkbenchFacets(
  facets: TagFacet[],
  mediaKind: "all" | "image" | "video" = "all",
): { aiGroup: WorkbenchFacet[]; manualGroup: WorkbenchFacet[] } {
  const aiGroup: WorkbenchFacet[] = [];
  const manualGroup: WorkbenchFacet[] = [];
  for (const f of facets) {
    if (f.status !== "active") continue;
    // appliesTo：分面声明只适用于图片/视频时，另一类素材的工作台不显示它
    if (mediaKind !== "all" && f.appliesTo !== "all" && f.appliesTo !== mediaKind) continue;
    const item: WorkbenchFacet = {
      key: f.key,
      displayName: f.displayName,
      description: f.description,
      inputMode: f.inputMode,
      selectionMode: f.selectionMode,
      maxItems: f.maxItems,
    };
    if (f.inputMode === "ai_and_manual") aiGroup.push(item);
    else manualGroup.push(item);
  }
  return { aiGroup, manualGroup };
}

/** W3-2/W2-10：把 AI/素材返回的分类标签 key 归一化为稳定 facetKey。
 *  knownFacetKeys 来自后端 facets（tagStore.facets）—— 自建分面的 key 原样保留；
 *  未知的先查中文旧名表（历史数据），仍未知才归 custom。 */
export function normalizeTagKeys(
  tags: Record<string, string[]>,
  knownFacetKeys: string[] = [],
): Record<string, string[]> {
  const known = new Set(knownFacetKeys);
  const out: Record<string, string[]> = {};
  for (const [name, list] of Object.entries(tags)) {
    const trimmed = name.trim();
    const key = known.has(trimmed)
      ? trimmed
      : (() => {
          const mapped = keyForLegacyName(trimmed);
          return known.has(mapped) ? mapped : "custom";
        })();
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
