/** 选中操作条（PRD v2.8）：顶栏内联，统一文字按钮风格，无特殊色框。 */
import Button from "@/components/common/Button";
import { useShallow } from "zustand/react/shallow";
import { useSelectionStore } from "@/stores/selectionStore";

interface Props {
  onTag: () => void;
  onExport: () => void;
  onMove: () => void;
  onDelete: () => void;
}

export default function ContextActionBar({ onTag, onExport, onMove, onDelete }: Props) {
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

      <Button onClick={guard(onTag, "批量打标")}>打标</Button>

      <Button onClick={guard(onExport, "导出")}>导出</Button>
      <Button onClick={guard(onMove, "移动")}>移动到…</Button>
      <Button disabled={truncated} title={truncated ? "当前结果超过 100000 张，请先收窄条件再删除" : undefined} onClick={onDelete}>删除</Button>
      <Button onClick={clear}>取消</Button>
    </div>
  );
}
