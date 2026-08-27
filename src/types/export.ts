/** 导出任务（指导书 §6.8：网盘已从正常 UI 移除，仅保留本地文件导出目标）。 */

export type ExportTarget = "local";

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
  /** P1-04：status=done 时的软提示（如「N 个源文件未能清理」），成功但不完全干净 */
  warning: string | null;
}