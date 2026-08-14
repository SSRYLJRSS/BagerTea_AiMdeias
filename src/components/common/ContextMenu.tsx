/** 通用右键菜单（PRD 5.4-4）：固定定位、点外/Esc 关闭、边缘防溢出、支持悬停二级菜单
 *  注意：点外关闭的捕获监听必须排除菜单内部，否则菜单项点击会被关闭抢先拦截
 */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";

export type MenuEntry =
  | { label: string; disabled?: boolean; onClick: () => void }
  | { label: string; children: { label: string; onClick: () => void }[] }
  | { divider: true };

interface ContextMenuProps {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose: () => void;
}

const MENU_W = 168;

export default function ContextMenu({ x, y, entries, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [openSub, setOpenSub] = useState<number | null>(null);

  useEffect(() => {
    // 捕获阶段监听点外关闭，但菜单内部点击必须放行（否则菜单项 onClick 永远到不了）
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  // 边缘防溢出
  const estH = entries.length * 30 + 8;
  const left = Math.min(x, window.innerWidth - MENU_W - 8);
  const top = Math.min(y, window.innerHeight - estH - 8);

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[168px] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] py-1 shadow-lg"
      style={{ left, top }}
    >
      {entries.map((entry, i) => {
        if ("divider" in entry) {
          return <div key={i} className="mx-2 my-1 h-px bg-[var(--color-border)]" />;
        }
        if ("children" in entry) {
          return (
            <div key={i} className="relative" onMouseEnter={() => setOpenSub(i)} onMouseLeave={() => setOpenSub(null)}>
              <div className="flex w-full cursor-default items-center justify-between px-3 py-1.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface)]">
                {entry.label}
                <span className="text-[10px] text-[var(--color-text-secondary)]">▸</span>
              </div>
              {openSub === i && (
                <div className="absolute top-0 left-full z-50 ml-0.5 min-w-[96px] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] py-1 shadow-lg">
                  {entry.children.map((c, j) => (
                    <button
                      key={j}
                      onClick={() => {
                        onClose();
                        c.onClick();
                      }}
                      className="flex w-full items-center px-3 py-1.5 text-left text-sm text-[var(--color-text)] transition-colors hover:bg-[var(--color-surface)]"
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        }
        return (
          <button
            key={i}
            disabled={entry.disabled}
            onClick={() => {
              onClose();
              entry.onClick();
            }}
            className={clsx(
              "flex w-full items-center px-3 py-1.5 text-left text-sm text-[var(--color-text)] transition-colors hover:bg-[var(--color-surface)] disabled:opacity-40",
            )}
          >
            {entry.label}
          </button>
        );
      })}
    </div>
  );
}
