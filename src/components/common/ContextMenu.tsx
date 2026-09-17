/** 通用右键菜单（PRD 5.4-4）：固定定位、点外/Esc 关闭、边缘防溢出、支持悬停二级菜单
 *  注意：点外关闭的捕获监听必须排除菜单内部，否则菜单项点击会被关闭抢先拦截
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import clsx from "clsx";

export type MenuEntry =
  | { label: string; disabled?: boolean; title?: string; onClick: () => void }
  | { label: string; children: ({ label: string; onClick: () => void } | { divider: true })[] }
  | { divider: true };

interface ContextMenuProps {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose: () => void;
}

const MENU_W = 168;
const SUBMENU_W = 96;
const VIEWPORT_GAP = 8;

export default function ContextMenu({ x, y, entries, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const [openSub, setOpenSub] = useState<number | null>(null);
  const [submenuTop, setSubmenuTop] = useState(0);

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
  const left = Math.max(VIEWPORT_GAP, Math.min(x, window.innerWidth - MENU_W - VIEWPORT_GAP));
  const top = Math.max(VIEWPORT_GAP, Math.min(y, window.innerHeight - estH - VIEWPORT_GAP));

  useLayoutEffect(() => {
    if (openSub == null || !submenuRef.current) return;
    const rect = submenuRef.current.getBoundingClientRect();
    const overflow = rect.bottom - (window.innerHeight - VIEWPORT_GAP);
    setSubmenuTop(overflow > 0 ? -overflow : 0);
  }, [openSub]);

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
                <div
                  ref={submenuRef}
                  className="absolute left-full z-50 min-w-[96px] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] py-1 shadow-lg"
                  style={{
                    top: submenuTop,
                    marginLeft: -1,
                    transform: left + MENU_W + SUBMENU_W > window.innerWidth - VIEWPORT_GAP ? `translateX(-${MENU_W + SUBMENU_W + 2}px)` : undefined,
                  }}
                >
                  {entry.children.map((c, j) =>
                    "divider" in c ? (
                      <div key={j} className="mx-2 my-1 border-t border-[var(--color-border)]" />
                    ) : (
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
                    ),
                  )}
                </div>
              )}
            </div>
          );
        }
        return (
          <button
            key={i}
            disabled={entry.disabled}
            title={entry.title}
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
