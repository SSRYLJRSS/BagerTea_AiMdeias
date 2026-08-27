/** Hover Intent（指导书阶段 4 §7.2）：鼠标进入 300ms 后激活，快速扫过不触发；
 *  离开 300~500ms 后关闭；键盘 focus 也视为进入；disabled（无 hover 环境/代理关闭）时不激活。 */
import { useCallback, useEffect, useRef, useState } from "react";

interface HoverIntentOptions {
  /** 进入后延迟 ms 才激活（默认 300） */
  enter?: number;
  /** 离开后延迟 ms 才关闭（默认 350） */
  leave?: number;
  disabled?: boolean;
}

export interface HoverIntentResult {
  /** 当前是否应显示预览 */
  active: boolean;
  /** 指针/焦点是否在目标内（用于浮层内保持打开） */
  inside: boolean;
  /** 绑定到触发器上的事件 props */
  triggerProps: {
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    onFocus: () => void;
    onBlur: () => void;
  };
  /** 立即取消待激活/待关闭计时（切换卡片时调用） */
  cancel: () => void;
}

export function useHoverIntent(options: HoverIntentOptions = {}): HoverIntentResult {
  const { enter = 300, leave = 350, disabled = false } = options;
  const [active, setActive] = useState(false);
  const [inside, setInside] = useState(false);
  const enterTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const clearTimers = useCallback(() => {
    if (enterTimer.current) clearTimeout(enterTimer.current);
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    enterTimer.current = null;
    leaveTimer.current = null;
  }, []);

  const cancel = useCallback(() => {
    clearTimers();
    setActive(false);
    setInside(false);
  }, [clearTimers]);

  const onEnter = useCallback(() => {
    if (disabledRef.current) return;
    if (!disabledRef.current) setInside(true);
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    enterTimer.current = setTimeout(() => setActive(true), enter);
  }, [enter]);

  const onLeave = useCallback(() => {
    setInside(false);
    if (enterTimer.current) clearTimeout(enterTimer.current);
    leaveTimer.current = setTimeout(() => setActive(false), leave);
  }, [leave]);

  useEffect(() => clearTimers, [clearTimers]);

  return {
    active,
    inside,
    triggerProps: {
      onMouseEnter: onEnter,
      onMouseLeave: onLeave,
      onFocus: onEnter,
      onBlur: onLeave,
    },
    cancel,
  };
}
