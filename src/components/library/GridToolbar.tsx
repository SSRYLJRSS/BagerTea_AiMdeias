/** 顶栏（PRD v2.7）：搜索框 + 选中操作条（并入）+ 排序下拉（R-21）+ 总数
 *  类型筛选已移入左侧栏「类型」区；回收站模式（R-22）渲染恢复/彻底删除操作条
 */
import { useState } from "react";
import clsx from "clsx";
import { Grid3x3, Grid2x2, Square } from "lucide-react";
import SearchInput from "@/components/common/SearchInput";
import Button from "@/components/common/Button";
import ContextActionBar from "@/components/library/ContextActionBar";
import SelectedFilterTags from "@/components/library/SelectedFilterTags";
import { useShallow } from "zustand/react/shallow";
import { useLibraryStore } from "@/stores/libraryStore";
import { useSelectionStore } from "@/stores/selectionStore";
import { useAppearance } from "@/hooks/useAppearance";
import { useSettingsStore } from "@/stores/settingsStore";
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

/** R-21 排序选项（与后端 AssetFilter.sortBy 对齐）；W2-8 补「评级」 */
const SORT_OPTIONS: { value: "created_at" | "taken_at" | "size" | "resolution" | "name" | "modified_at" | "rating"; label: string }[] = [
  { value: "created_at", label: "入库时间" },
  { value: "taken_at", label: "拍摄时间" },
  { value: "modified_at", label: "修改时间" },
  { value: "name", label: "文件名" },
  { value: "size", label: "文件大小" },
  { value: "resolution", label: "分辨率" },
  { value: "rating", label: "评级" },
];

/** FB2-01 三态大小入口：小/中/大 → 档位 1 / 3 / 5（与滚轮、Ctrl+± 状态同步） */
const SIZE_STEPS = [
  { step: 1, label: "小", Icon: Grid3x3, title: "格子小" },
  { step: 3, label: "中", Icon: Grid2x2, title: "格子中" },
  { step: 5, label: "大", Icon: Square, title: "格子大" },
];

export default function GridToolbar({ onAiTag, onAssignTags, onExport, onMove, onDelete, onDedup, onPurge }: GridToolbarProps) {
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
  // FB2-01 可发现入口：素材库顶栏三态大小切换（小/中/大 = 档位 1/3/5）
  const { grid } = useAppearance();

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

  // FB2-01：顶栏点击三态大小 → 即时预览 + 防抖持久化（与滚轮档位同一管道路径）
  const setSizeStep = (step: number) => {
    if (step === grid.libraryCellStep) return;
    useSettingsStore.getState().commitAppearanceDebounced((a) => ({
      ...a,
      grid: { ...a.grid, libraryCellStep: step },
    }));
  };

  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-[var(--color-border)] px-3">
      {/* 设置入口已移至顶部标题栏（指导书 §10.1），此处移除避免重复入口与导航状态分叉 */}
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
          {/* W0-7：恢复去重入口（dedup_scan + DupDialog 已交付但此前不可达）。hash 重复组为 0 时显示「没有重复」是正确结果 */}
          {onDedup && (
            <button
              type="button"
              onClick={onDedup}
              className="shrink-0 rounded px-1.5 py-0.5 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
              title="扫描内容完全相同的素材（精确 hash 去重）"
            >
              查找重复
            </button>
          )}
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

      {/* FB2-01 可发现入口：三态大小（小/中/大） */}
      <div className="flex shrink-0 items-center overflow-hidden rounded-md border border-[var(--color-border)]">
        {SIZE_STEPS.map(({ step, label, Icon, title }) => (
          <button
            key={step}
            type="button"
            onClick={() => setSizeStep(step)}
            aria-label={label}
            aria-pressed={grid.libraryCellStep === step}
            title={title}
            data-active={grid.libraryCellStep === step}
            className={clsx(
              "flex h-6 w-7 items-center justify-center text-[var(--color-text-secondary)] transition-colors",
              grid.libraryCellStep === step
                ? "bg-[var(--color-accent)] text-[var(--color-accent-text)]"
                : "hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]",
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
          </button>
        ))}
      </div>

      <span className="ml-auto shrink-0 text-xs text-[var(--color-text-secondary)]">{total} 项</span>
    </div>
  );
}
