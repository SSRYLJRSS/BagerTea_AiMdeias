/** 顶栏（PRD v2.7）：搜索框 + 选中操作条（并入）+ 排序下拉（R-21）+ 总数
 *  类型筛选已移入左侧栏「类型」区；回收站模式（R-22）渲染恢复/彻底删除操作条
 */
import { useState } from "react";
import SearchInput from "@/components/common/SearchInput";
import Button from "@/components/common/Button";
import ContextActionBar from "@/components/library/ContextActionBar";
import SelectedFilterTags from "@/components/library/SelectedFilterTags";
import { useShallow } from "zustand/react/shallow";
import { useLibraryStore } from "@/stores/libraryStore";
import { useSelectionStore } from "@/stores/selectionStore";
import { trashRestore } from "@/api/assets";

interface GridToolbarProps {
  onAiTag: () => void;
  onAssignTags: () => void;
  onExport: () => void;
  onMove: () => void;
  onDelete: () => void;
  /** 查找重复入口（暂隐藏，保留接线便于重新开启） */
  onDedup?: () => void;
  /** R-22：回收站模式下的「彻底删除」（弹窗由 LibraryPage 托管） */
  onPurge: () => void;
}

/** R-21 排序选项（与后端 AssetFilter.sortBy 对齐） */
const SORT_OPTIONS: { value: "created_at" | "taken_at" | "size" | "resolution" | "name" | "modified_at"; label: string }[] = [
  { value: "created_at", label: "入库时间" },
  { value: "taken_at", label: "拍摄时间" },
  { value: "modified_at", label: "修改时间" },
  { value: "name", label: "文件名" },
  { value: "size", label: "文件大小" },
  { value: "resolution", label: "分辨率" },
];

export default function GridToolbar({ onAiTag, onAssignTags, onExport, onMove, onDelete, onPurge }: GridToolbarProps) {
  const { setFilter, total, sortBy, sortDir, trashOnly, removeLocal } = useLibraryStore(
    useShallow((s) => ({
      setFilter: s.setFilter,
      total: s.total,
      sortBy: s.filter.sortBy,
      sortDir: s.filter.sortDir,
      trashOnly: s.filter.trashOnly,
      removeLocal: s.removeLocal,
    })),
  );
  const { selected, clear } = useSelectionStore(useShallow((s) => ({ selected: s.selected, clear: s.clear })));
  const [restoring, setRestoring] = useState(false);

  const restore = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0 || restoring) return;
    setRestoring(true);
    try {
      await trashRestore(ids);
      removeLocal(ids);
      clear();
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-[var(--color-border)] px-3">
      {/* 设置入口（库页顶栏左侧，与搜索同行） */}
      <button
        onClick={() => window.dispatchEvent(new CustomEvent("app:navigate", { detail: "settings" }))}
        className="shrink-0 rounded px-2 py-1 text-sm text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
      >
        设置
      </button>

      <SearchInput onSearch={(kw) => setFilter({ search: kw })} />
      <SelectedFilterTags />

      {trashOnly ? (
        /* R-22 回收站操作条：恢复 / 彻底删除 */
        selected.size > 0 ? (
          <div className="flex min-w-0 items-center gap-0.5">
            <span className="shrink-0 text-xs text-[var(--color-text-secondary)]">已选中 {selected.size} 项</span>
            <span className="mx-1 h-4 w-px shrink-0 bg-[var(--color-border)]" />
            <Button onClick={() => void restore()} disabled={restoring}>
              {restoring ? "恢复中…" : "恢复"}
            </Button>
            <Button variant="danger" onClick={onPurge}>彻底删除</Button>
            <Button onClick={clear}>取消</Button>
          </div>
        ) : (
          <span className="shrink-0 text-xs text-[var(--color-text-secondary)]">
            回收站 · 超期自动清理（见设置）
          </span>
        )
      ) : (
        <>
          <ContextActionBar onAiTag={onAiTag} onAssignTags={onAssignTags} onExport={onExport} onMove={onMove} onDelete={onDelete} />
          {/* R-21 排序下拉 + 方向切换 */}
          <div className="flex shrink-0 items-center gap-0.5">
            <select
              value={sortBy}
              onChange={(e) => setFilter({ sortBy: e.target.value as typeof sortBy })}
              className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-xs text-[var(--color-text-secondary)] outline-none hover:text-[var(--color-text)]"
              title="排序方式"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <button
              onClick={() => setFilter({ sortDir: sortDir === "desc" ? "asc" : "desc" })}
              className="rounded px-1.5 py-0.5 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
              title={sortDir === "desc" ? "当前降序，点击切换升序" : "当前升序，点击切换降序"}
            >
              {sortDir === "desc" ? "↓" : "↑"}
            </button>
          </div>
        </>
      )}

      <span className="ml-auto shrink-0 text-xs text-[var(--color-text-secondary)]">{total} 项</span>
    </div>
  );
}
