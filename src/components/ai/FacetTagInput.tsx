/** 分面标签输入（指导书 §9.5 录入顺序）：
 *  按当前 facetKey 先搜规范名 → 再搜 alias → 展示完整路径/所属分面；
 *  选择已有规范标签直接加入，只有用户明确确认（Enter）才把新词加入候选，最终由后端确认写入时创建正式标签。
 *  AI 未知词只进入候选，不创建正式标签。 */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { searchTagCandidates, recentTagOps } from "@/api/tags";
import type { Tag } from "@/types/tag";

/** 最近使用标签名（去重，模块级缓存；§9.5「最近使用标签」） */
let recentCache: string[] | null = null;
let recentPromise: Promise<string[]> | null = null;

/** 测试/清理用：清空最近使用缓存 */
export function clearRecentTagCache(): void {
  recentCache = null;
  recentPromise = null;
}
function getRecentTagNames(): Promise<string[]> {
  if (recentCache) return Promise.resolve(recentCache);
  if (!recentPromise) {
    recentPromise = recentTagOps(200)
      .then((ops) => {
        const names: string[] = [];
        const seen = new Set<string>();
        for (const o of ops) {
          if (o.op === "add" && !seen.has(o.tagName)) {
            seen.add(o.tagName);
            names.push(o.tagName);
          }
        }
        recentCache = names;
        return names;
      })
      .catch(() => []);
  }
  return recentPromise;
}

interface FacetTagInputProps {
  facetKey: string;
  value: string;
  onValueChange: (v: string) => void;
  onCommit: (name: string) => void;
  readOnly?: boolean;
  placeholder?: string;
}

export default function FacetTagInput({
  facetKey,
  value,
  onValueChange,
  onCommit,
  readOnly = false,
  placeholder = "+ 加标签",
}: FacetTagInputProps) {
  const [candidates, setCandidates] = useState<Tag[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [focused, setFocused] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // 输入聚焦且为空时展示「最近使用标签」（§9.5）
  useEffect(() => {
    if (value.trim() !== "") return;
    let cancelled = false;
    void getRecentTagNames().then((names) => {
      if (!cancelled) {
        setRecent(names.slice(0, 8));
        if (focused) setOpen(names.length > 0);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [value, focused]);

  // 按当前 facetKey 搜索规范名 + 别名（§9.5）
  useEffect(() => {
    if (readOnly) return;
    if (!value.trim()) {
      setCandidates([]);
      setOpen(false);
      return;
    }
    const t = setTimeout(() => {
      void searchTagCandidates(facetKey, value.trim())
        .then((c) => {
          setCandidates(c);
          setOpen(c.length > 0);
          setHighlight(-1);
        })
        .catch(() => {
          setCandidates([]);
          setOpen(false);
        });
    }, 200);
    return () => clearTimeout(t);
  }, [facetKey, value, readOnly]);

  const commit = (name: string) => {
    const n = name.trim();
    if (!n) return;
    onCommit(n);
    onValueChange("");
    setOpen(false);
    setHighlight(-1);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (open && highlight >= 0 && candidates[highlight]) commit(candidates[highlight].name);
      else commit(value);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, candidates.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={boxRef} className="relative min-w-20 flex-1">
      <input
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => {
          setFocused(true);
          if (value.trim() === "") setOpen(recent.length > 0);
          else if (candidates.length) setOpen(true);
        }}
        onBlur={() => {
          setFocused(false);
          setTimeout(() => setOpen(false), 120);
        }}
        disabled={readOnly}
        placeholder={placeholder}
        className="ui-control w-full px-2 py-1 text-xs"
      />
      {open && candidates.length > 0 && (
        <ul
          role="listbox"
          className="absolute right-0 left-0 z-20 mt-1 max-h-40 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] py-1 shadow-md"
        >
          {candidates.map((c, i) => (
            <li
              key={c.id}
              role="option"
              aria-selected={i === highlight}
              onMouseDown={(e) => {
                e.preventDefault();
                commit(c.name);
              }}
              onMouseEnter={() => setHighlight(i)}
              className={clsx(
                "cursor-pointer px-2 py-1 text-xs text-[var(--color-text)]",
                i === highlight ? "bg-[var(--color-surface-hover)]" : "",
              )}
            >
              <span className="block truncate">{c.name}</span>
              <span className="block truncate text-[10px] text-[var(--color-text-secondary)]">
                {c.path} · {c.facetKey}
              </span>
            </li>
          ))}
        </ul>
      )}
      {open && value.trim() === "" && recent.length > 0 && (
        <ul
          role="listbox"
          aria-label="最近使用标签"
          className="absolute right-0 left-0 z-20 mt-1 max-h-40 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] py-1 shadow-md"
        >
          <li className="px-2 pt-1 pb-0.5 text-[10px] text-[var(--color-text-tertiary)]">最近使用</li>
          {recent.map((name) => (
            <li
              key={name}
              role="option"
              onMouseDown={(e) => {
                e.preventDefault();
                commit(name);
              }}
              className="cursor-pointer px-2 py-1 text-xs text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]"
            >
              <span className="block truncate">{name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
