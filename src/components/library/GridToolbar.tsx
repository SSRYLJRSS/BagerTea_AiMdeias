/** 顶栏（PRD v2.7）：搜索框 + 选中操作条（并入）+ 总数
 *  类型筛选已移入左侧栏「类型」区
 */
import SearchInput from "@/components/common/SearchInput";
import ContextActionBar from "@/components/library/ContextActionBar";
import { useShallow } from "zustand/react/shallow";
import { useLibraryStore } from "@/stores/libraryStore";

interface GridToolbarProps {
  onAiTag: () => void;
  onAssignTags: () => void;
  onExport: () => void;
  onDelete: () => void;
}

export default function GridToolbar({ onAiTag, onAssignTags, onExport, onDelete }: GridToolbarProps) {
  const { setFilter, total } = useLibraryStore(useShallow((s) => ({ setFilter: s.setFilter, total: s.total })));

  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-[var(--color-border)] px-3">
      <SearchInput onSearch={(kw) => setFilter({ search: kw })} />
      <ContextActionBar onAiTag={onAiTag} onAssignTags={onAssignTags} onExport={onExport} onDelete={onDelete} />
      <span className="ml-auto shrink-0 text-xs text-[var(--color-text-secondary)]">{total} 项</span>
    </div>
  );
}
