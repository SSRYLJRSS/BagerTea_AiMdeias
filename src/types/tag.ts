/** 标签（父子层级·方案B） */

export interface Tag {
  id: number;
  name: string;
  parentId: number | null;
  isPreset: boolean;
  sortOrder: number;
  /** 自身直接关联素材数 */
  assetCount: number;
  /** 自身+后代合计（父标签显示值） */
  totalCount: number;
}

export interface TagNode {
  tag: Tag;
  children: TagNode[];
}
