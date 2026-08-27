import { useCallback, useEffect, useRef } from "react";

/** 单击/双击互斥（P2.3）：单击延迟执行，双击取消单击。仅用于素材库入口。
 *  - onSingle：延迟 delayMs 后执行（未触发双击）。
 *  - onDouble：清除单击计时并立即执行。
 *  - 返回 { onClick, onDoubleClick } 供组件绑定；unmount 自动清理计时。
 */
export function useDoubleAction(onSingle: () => void, onDouble: () => void, delayMs = 230) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSingleRef = useRef(onSingle);
  const onDoubleRef = useRef(onDouble);
  onSingleRef.current = onSingle;
  onDoubleRef.current = onDouble;

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const click = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      onSingleRef.current();
    }, delayMs);
  }, [delayMs]);

  const dblclick = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    onDoubleRef.current();
  }, []);

  return { onClick: click, onDoubleClick: dblclick };
}
