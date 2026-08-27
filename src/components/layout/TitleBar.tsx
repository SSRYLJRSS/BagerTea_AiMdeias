import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import appLogo from "@/assets/icon-logo.png";

/** 自定义标题栏（无边框窗口）：左侧应用 logo + 应用名，右侧窗口控制（最小化/最大化/关闭），中间整条可拖拽。
 *  风格对齐 VS Code —— 单行、logo 在最前，窗口控制按钮在右侧。
 *  tauri.conf.json 需保持 decorations: false；窗口命令需 core:window:allow-minimize / toggle-maximize / close / start-dragging。
 */
export default function TitleBar() {
  const [maximized, setMaximized] = useState(false);

  // 在 Tauri 环境中监听窗口最大化状态，用于在「最大化/还原」图标之间切换
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;
    const setup = async () => {
      try {
        const w = getCurrentWindow();
        setMaximized(await w.isMaximized());
        const fn = await w.onResized(() => {
          void w
            .isMaximized()
            .then((m) => {
              if (active) setMaximized(m);
            })
            .catch(() => {});
        });
        if (!active) fn();
        else unlisten = fn;
      } catch {
        // 非 Tauri 环境（测试/纯浏览器预览）：忽略窗口控制
      }
    };
    void setup();
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const win = () => {
    try {
      return getCurrentWindow();
    } catch {
      return null;
    }
  };

  const minimize = () => {
    const w = win();
    if (w) void w.minimize().catch(() => {});
  };
  const toggleMaximize = () => {
    const w = win();
    if (w) void w.toggleMaximize().catch(() => {});
  };
  const close = () => {
    const w = win();
    if (w) void w.close().catch(() => {});
  };

  return (
    <header
      data-tauri-drag-region
      className="relative flex h-10 shrink-0 select-none items-stretch border-b border-[var(--color-border)] bg-[var(--color-bg)]"
    >
      {/* 左侧：logo + 应用名（可拖拽） */}
      <div data-tauri-drag-region className="flex items-center gap-2 px-3">
        <img src={appLogo} alt="茶包素材" className="pointer-events-none h-6 w-6 select-none" draggable={false} />
        <span data-tauri-drag-region className="text-sm font-medium text-[var(--color-text)]">
          茶包素材 BagerTea V2
        </span>
      </div>

      {/* 中间空白拖拽区 */}
      <div data-tauri-drag-region className="min-w-0 flex-1" />

      {/* 右侧：窗口控制 */}
      <div className="flex items-stretch">
        <button
          onClick={minimize}
          aria-label="最小化"
          className="flex w-11 items-center justify-center text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
        >
          <MinimizeIcon />
        </button>
        <button
          onClick={toggleMaximize}
          aria-label={maximized ? "还原" : "最大化"}
          className="flex w-11 items-center justify-center text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
        >
          {maximized ? <RestoreIcon /> : <MaximizeIcon />}
        </button>
        <button
          onClick={close}
          aria-label="关闭"
          className="flex w-11 items-center justify-center text-[var(--color-text-secondary)] transition-colors hover:bg-[#e81123] hover:text-white"
        >
          <CloseIcon />
        </button>
      </div>
    </header>
  );
}

function MinimizeIcon() {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      <path d="M0.5 5h9" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      {/* 背面方块：只画未被正面方块遮住的 上+左+底左 边 */}
      <path d="M7 3V1H1v6h2" fill="none" stroke="currentColor" strokeWidth="1" />
      {/* 正面方块 */}
      <path d="M3 3h6v6H3z" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      <path d="M0.7 0.7 L9.3 9.3 M9.3 0.7 L0.7 9.3" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );
}
