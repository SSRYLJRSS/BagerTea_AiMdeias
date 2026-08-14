/** 导出任务（本地/网盘统一模型） */

export type ExportTarget = "local" | "baidu" | "quark";

export interface ExportTask {
  id: number;
  target: ExportTarget;
  status: "pending" | "running" | "done" | "failed" | "cancelled";
  total: number;
  done: number;
  destDir: string | null;
  shareUrl: string | null;
  error: string | null;
  createdAt: number;
}
