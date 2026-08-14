/**
 * API 封装层统一入口（架构 §3.3）：
 * - 页面禁止直接 invoke，统一走 src/api/*；
 * - 后端 AppError { code, message } → 前端 AppError；
 * - on() 订阅后端进度事件，返回取消订阅函数。
 */
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen, type Event, type UnlistenFn } from "@tauri-apps/api/event";

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch (e) {
    const err = e as { code?: string; message?: string } | undefined;
    throw new AppError(err?.code ?? "UNKNOWN", err?.message ?? String(e));
  }
}

/** 事件订阅：on<T>("import://progress", handler) → 返回 unsubscribe */
export function on<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(event, (e: Event<T>) => handler(e.payload));
}
