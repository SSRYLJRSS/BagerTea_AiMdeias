/** 批量改名构造器（PRD v2.6）：占位符按钮点选拼装，替代手输模板
 *  逻辑：点击 token 追加到末尾并高亮；再点取消；顺序 = 点击顺序，以 "_" 拼接
 */
import { useEffect, useState } from "react";
import clsx from "clsx";
import { renderNamePreview } from "@/api/import";

const TOKENS: { id: string; label: string }[] = [
  { id: "{分库}", label: "分库" },
  { id: "{日期}", label: "日期" },
  { id: "{原名}", label: "原名" },
  { id: "SEQ", label: "序号" }, // 序号选中后手输位数 → {序号:N}
];

const SEQ_RE = /^\{序号(?::(\d+))?\}$/;
const KNOWN = new Set(["{分库}", "{日期}", "{原名}"]);

/** 从已有模板反解按钮选中态；返回 [选中序列, 序号位数] */
function parsePattern(pattern: string): [string[], string] {
  if (!pattern.trim()) return [[], "3"];
  const sel: string[] = [];
  let digits = "3";
  for (const seg of pattern.split("_")) {
    if (KNOWN.has(seg)) sel.push(seg);
    else {
      const m = SEQ_RE.exec(seg);
      if (m) {
        sel.push("SEQ");
        if (m[1]) digits = m[1];
      }
    }
  }
  return [sel, digits];
}

interface RenameBuilderProps {
  value: string;
  onChange: (pattern: string) => void;
  disabled?: boolean;
  /** 实时预览素材：分库名 + 首个文件名 */
  collection: string;
  sampleStem: string;
  sampleExt: string;
}

export default function RenameBuilder({ value, onChange, disabled, collection, sampleStem, sampleExt }: RenameBuilderProps) {
  const [selected, setSelected] = useState<string[]>(() => parsePattern(value)[0]);
  const [seqDigits, setSeqDigits] = useState<string>(() => parsePattern(value)[1]);

  /** SEQ 占位符按位数展开为真实 token */
  const expand = (sel: string[], digits: string) =>
    sel.map((id) => (id === "SEQ" ? (digits.trim() ? `{序号:${digits.trim()}}` : "{序号}") : id));

  const emit = (sel: string[], digits: string) => onChange(expand(sel, digits).join("_"));

  // 外部清空（如切换场景）时同步按钮态；仅初始化/外部清空时触发
  useEffect(() => {
    if (!value.trim() && selected.length > 0) setSelected([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const toggle = (id: string) => {
    const next = selected.includes(id) ? selected.filter((t) => t !== id) : [...selected, id];
    setSelected(next);
    emit(next, seqDigits);
  };

  const changeDigits = (v: string) => {
    const digits = v.replace(/[^1-9]/g, "").slice(0, 1); // 1-9 一位
    setSeqDigits(digits);
    if (selected.includes("SEQ")) emit(selected, digits);
  };

  const clear = () => {
    setSelected([]);
    onChange("");
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs text-[var(--color-text-secondary)]">批量改名（点选拼装，留空不改名）</span>
        {selected.length > 0 && (
          <button onClick={clear} disabled={disabled} className="text-[10px] text-[var(--color-text-secondary)] hover:text-[var(--color-danger)]">
            清空
          </button>
        )}
      </div>

      {/* token 按钮区：选中高亮，顺序即拼接顺序 */}
      <div className="flex flex-wrap items-center gap-1">
        {TOKENS.map(({ id, label }) => {
          const order = selected.indexOf(id);
          const active = order >= 0;
          return (
            <span key={id} className="flex items-center gap-1">
              <button
                onClick={() => toggle(id)}
                disabled={disabled}
                title={id === "SEQ" ? (seqDigits.trim() ? `{序号:${seqDigits}}` : "{序号}") : id}
                className={clsx(
                  "relative rounded-md border px-2 py-1 text-xs transition-all duration-150 disabled:opacity-40",
                  active
                    ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-text)]"
                    : "border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-text-secondary)] hover:text-[var(--color-text)]",
                )}
              >
                {label}
                {active && selected.length > 1 && (
                  <span className="absolute -top-1.5 -right-1.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[var(--color-text)] text-[9px] text-[var(--color-bg)]">
                    {order + 1}
                  </span>
                )}
              </button>
              {/* 序号选中后：手输位数（1-9） */}
              {id === "SEQ" && active && (
                <input
                  value={seqDigits}
                  onChange={(e) => changeDigits(e.target.value)}
                  disabled={disabled}
                  inputMode="numeric"
                  title="序号位数（1-9）"
                  className="w-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-1 text-center text-xs outline-none focus:border-[var(--color-accent)] disabled:opacity-40"
                />
              )}
            </span>
          );
        })}
      </div>

      {/* 生成的模板 + 实时预览 */}
      {selected.length > 0 && (
        <div className="flex flex-col gap-0.5 rounded-md bg-[var(--color-surface)] px-2 py-1.5 transition-all duration-200">
          <span className="font-mono text-[10px] text-[var(--color-text-secondary)]">{expand(selected, seqDigits).join("_")}</span>
          {sampleStem && (
            <span className="text-[10px] text-[var(--color-text)]">
              预览：{renderNamePreview(expand(selected, seqDigits).join("_"), collection, sampleStem)}.{sampleExt}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
