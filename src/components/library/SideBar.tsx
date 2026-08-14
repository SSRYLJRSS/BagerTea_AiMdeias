/** 左侧栏（PRD v2.7）：「类型」区（全部/图片/视频/未打标）+「标签」区（树形导航）
 *  操作区（导入/导出/网盘）已删：导入走入库页，导出走选中操作条
 */
import clsx from "clsx";
import { useShallow } from "zustand/react/shallow";
import TagTree from "./TagTree";
import { useLibraryStore } from "@/stores/libraryStore";
import type { AssetType } from "@/types/asset";

const TYPE_TABS: { key: string; label: string; assetType: AssetType }[] = [
  { key: "all", label: "全部", assetType: "all" },
  { key: "image", label: "图片", assetType: "image" },
  { key: "video", label: "视频", assetType: "video" },
];

export default function SideBar() {
  const { filter, setFilter } = useLibraryStore(useShallow((s) => ({ filter: s.filter, setFilter: s.setFilter })));
  const activeKey = filter.untaggedOnly ? null : filter.assetType;

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
              onClick={() => setFilter({ assetType: t.assetType, untaggedOnly: false })}
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
        </div>
      </div>

      {/* 标签区 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        <h3 className="px-2 pt-1 pb-0.5 text-[10px] font-medium tracking-wide text-[var(--color-text-secondary)] uppercase">
          标签
        </h3>
        <TagTree />
      </div>
    </aside>
  );
}
