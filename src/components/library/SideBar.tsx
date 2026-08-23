/** 左侧栏（PRD v2.7）：「类型」区（全部/图片/视频/未打标）+「标签」区（树形导航）
 *  操作区（导入/导出/网盘）已删：导入走入库页，导出走选中操作条
 */
import clsx from "clsx";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import TagTree from "./TagTree";
import TagManageDialog from "@/components/dialogs/TagManageDialog";
import { useLibraryStore } from "@/stores/libraryStore";
import type { AssetType } from "@/types/asset";

const TYPE_TABS: { key: string; label: string; assetType: AssetType }[] = [
  { key: "all", label: "全部", assetType: "all" },
  { key: "image", label: "图片", assetType: "image" },
  { key: "video", label: "视频", assetType: "video" },
];

export default function SideBar() {
  const { filter, setFilter } = useLibraryStore(useShallow((s) => ({ filter: s.filter, setFilter: s.setFilter })));
  const [manageOpen, setManageOpen] = useState(false);
  const activeKey = filter.trashOnly ? "trash" : filter.untaggedOnly ? null : filter.assetType;

  return (
    <aside className="flex w-[150px] shrink-0 flex-col border-r border-[var(--color-border)]">
      {/* 类型区 */}
      <div className="border-b border-[var(--color-border)] p-2">
        <h3 className="px-1 pb-1 text-[10px] font-medium tracking-wide text-[var(--color-text-secondary)] uppercase">
          类型
        </h3>
        <div className="flex flex-col gap-0.5">
          {TYPE_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setFilter({ assetType: t.assetType, untaggedOnly: false, trashOnly: false })}
              className={clsx(
                "rounded px-2 py-1 text-left text-sm transition-colors",
                activeKey === t.key
                  ? "bg-[var(--color-surface)] font-medium text-[var(--color-text)]"
                  : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]",
              )}
            >
              {t.label}
            </button>
          ))}
          {/* R-22 回收站入口 */}
          <button
            onClick={() => setFilter({ trashOnly: true, untaggedOnly: false, tagId: null, assetType: "all" })}
            className={clsx(
              "rounded px-2 py-1 text-left text-sm transition-colors",
              activeKey === "trash"
                ? "bg-[var(--color-surface)] font-medium text-[var(--color-text)]"
                : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]",
            )}
          >
            回收站
          </button>
        </div>
      </div>

      {/* 标签区 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        <div className="flex items-center justify-between px-2 pt-1 pb-0.5">
          <h3 className="text-[10px] font-medium tracking-wide text-[var(--color-text-secondary)] uppercase">
            标签
          </h3>
          <button
            onClick={() => setManageOpen(true)}
            className="rounded px-1 text-[10px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
          >
            管理
          </button>
        </div>
        <TagTree />
      </div>
      <TagManageDialog open={manageOpen} onClose={() => setManageOpen(false)} />
    </aside>
  );
}
