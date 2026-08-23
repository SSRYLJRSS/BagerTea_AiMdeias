/** 全局任务条状态（M3-04 R-17）：聚合入库/导出/AI 打标既有进度事件，
 *  只读事件不加新后端；完成（done>=total）后短暂停留再自动消失 */
import { create } from "zustand";
import { onImportProgress } from "@/api/import";
import { onExportProgress } from "@/api/export";
import { onAiProgress } from "@/api/ai";
import type { UnlistenFn } from "@tauri-apps/api/event";

export interface GlobalTask {
  key: "import" | "export" | "ai";
  label: string;
  done: number;
  total: number;
}

interface TaskState {
  tasks: GlobalTask[];
}

export const useTaskStore = create<TaskState>(() => ({
  tasks: [],
}));

/** 完成条停留时长（毫秒）：让用户看到 100% 后再消失 */
const LINGER_MS = 1500;
const clearTimers = new Map<GlobalTask["key"], ReturnType<typeof setTimeout>>();

function upsert(key: GlobalTask["key"], label: string, done: number, total: number) {
  useTaskStore.setState((s) => {
    const others = s.tasks.filter((t) => t.key !== key);
    return { tasks: [...others, { key, label, done, total }] };
  });
  if (total > 0 && done >= total) {
    const prev = clearTimers.get(key);
    if (prev) clearTimeout(prev);
    clearTimers.set(
      key,
      setTimeout(() => {
        useTaskStore.setState((s) => ({ tasks: s.tasks.filter((t) => t.key !== key) }));
        clearTimers.delete(key);
      }, LINGER_MS),
    );
  }
}

let subscribed = false;
let unlisteners: UnlistenFn[] = [];

/** 订阅三类进度事件（幂等，App 挂载时调用一次）；
 *  失败可恢复：部分成功时逐个回收已建立监听（allSettled 才能拿到已 resolve 的
 *  unlisten 函数），复位 subscribed 允许下次调用惰性重试（P2-02/P2-11） */
export async function startGlobalTaskWatch(): Promise<void> {
  if (subscribed) return;
  subscribed = true; // 先置位防并发重入（App 挂载可能多次调用）
  try {
    const results = await Promise.allSettled([
      onImportProgress((p) => upsert("import", "入库中", p.current, p.total)),
      onExportProgress((p) => upsert("export", "导出中", p.done, p.total)),
      onAiProgress((p) => upsert("ai", "AI 打标中", p.processed, p.total)),
    ]);
    const failures = results.filter((r) => r.status === "rejected").length;
    if (failures > 0) {
      for (const r of results) {
        if (r.status === "fulfilled") unlisteners.push(r.value);
      }
      // 部分失败：整体回收，下次调用重试（避免半订阅 + 重复订阅叠加）
      for (const fn of unlisteners.splice(0)) fn();
      subscribed = false;
      console.error(`全局任务监听订阅失败 ${failures}/3 个事件，已回收并允许重试`);
    }
  } catch (e) {
    subscribed = false;
    console.error("全局任务监听订阅异常", e);
  }
}
