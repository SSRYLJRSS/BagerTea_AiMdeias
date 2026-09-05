/** 选中操作条（PRD v2.8）：顶栏内联，统一文字按钮风格，无特殊色框
 *  「打标」悬停浮出 AI / 手动；全选/反选已收进右键菜单
 */
import Button from "@/components/common/Button";
import { useShallow } from "zustand/react/shallow";
import { useSelectionStore } from "@/stores/selectionStore";

interface Props {
  onAiTag: () => void;
  onAssignTags: () => void;
  onExport: () => void;
  onMove: () => void;
  onDelete: () => void;
}

export default function ContextActionBar({ onAiTag, onAssignTags, onExport, onMove, onDelete }: Props) {
  const { selected, truncated, selectionTotal, clear } = useSelectionStore(
    useShallow((s) => ({ selected: s.selected, truncated: s.truncated, selectionTotal: s.selectionTotal, clear: s.clear })),
  );
  if (selected.size === 0) return null;

  // §4.6：截断集合上导出/移动/批量打标二次确认；删除直接禁用（不可逆 + 集合不完整）
  const guard = (action: () => void, noun: string) => () => {
    if (truncated) {
      const ok = window.confirm(`将${noun}已选中的 ${selected.size} 张（共 ${selectionTotal} 张匹配）。继续？`);
      if (!ok) return;
    }
    action();
  };

  return (
    <div className="flex min-w-0 items-center gap-0.5">
      {/* §4.6：截断时选择栏恒显示「已选 N / total」 */}
      <span className="shrink-0 text-xs text-[var(--color-text-secondary)]">
        {truncated ? `已选中 ${selected.size} / ${selectionTotal} 项` : `已选中 ${selected.size} 项`}
      </span>
      <span className="mx-1 h-4 w-px shrink-0 bg-[var(--color-border)]" />

      {/* 打标：悬停浮出 AI / 手动 */}
      <div className="group relative">
        <Button className="font-medium">打标 ▾</Button>
        <div className="invisible absolute top-full left-0 z-40 min-w-[96px] rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] py-1 opacity-0 shadow-lg transition-opacity duration-150 group-hover:visible group-hover:opacity-100">
          <button
            onClick={guard(onAiTag, "送 AI 批量打标")}
            className="flex w-full items-center px-3 py-1.5 text-left text-sm text-[var(--color-text)] transition-colors hover:bg-[var(--color-surface)]"
          >
            AI
          </button>
          <button
            onClick={guard(onAssignTags, "批量打标")}
            className="flex w-full items-center px-3 py-1.5 text-left text-sm text-[var(--color-text)] transition-colors hover:bg-[var(--color-surface)]"
          >
            手动
          </button>
        </div>
      </div>

      <Button onClick={guard(onExport, "导出")}>导出</Button>
      <Button onClick={guard(onMove, "移动")}>移动到…</Button>
      <Button disabled={truncated} title={truncated ? "当前结果超过 100000 张，请先收窄条件再删除" : undefined} onClick={onDelete}>删除</Button>
      <Button onClick={clear}>取消</Button>
    </div>
  );
}
