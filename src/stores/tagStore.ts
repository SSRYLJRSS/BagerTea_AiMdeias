/** 标签树状态：树数据 + 展开节点 + 选中筛选 */
import { create } from "zustand";
import { listTags } from "@/api/tags";
import type { TagNode } from "@/types/tag";

interface TagState {
  tree: TagNode[];
  loading: boolean;
  expanded: ReadonlySet<number>;
  refresh: () => Promise<void>;
  toggleExpand: (id: number) => void;
}

export const useTagStore = create<TagState>((set) => ({
  tree: [],
  loading: false,
  expanded: new Set<number>(),

  refresh: async () => {
    set({ loading: true });
    try {
      const tree = await listTags();
      // 首次加载默认展开顶级（有子的）
      set((s) => ({
        tree,
        loading: false,
        expanded: s.expanded.size === 0 ? collectDefaultExpanded(tree) : s.expanded,
      }));
    } catch {
      set({ loading: false });
    }
  },

  toggleExpand: (id) =>
    set((s) => {
      const next = new Set(s.expanded);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { expanded: next };
    }),
}));

function collectDefaultExpanded(tree: TagNode[]): ReadonlySet<number> {
  return new Set(tree.filter((n) => n.children.length > 0).map((n) => n.tag.id));
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
