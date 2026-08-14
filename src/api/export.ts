/** 导出相关命令封装（对应 commands/export_cmd.rs） */
import { invoke, on } from "./client";
import type { ExportTask } from "@/types/export";
import type { UnlistenFn } from "@tauri-apps/api/event";

export interface ExportProgress {
  taskId: number;
  done: number;
  total: number;
}

export function exportLocalFiles(
  assetIds: number[],
  destDir: string,
  mode: "copy" | "move",
): Promise<ExportTask> {
  return invoke<ExportTask>("export_local_files", { assetIds, destDir, mode });
}

export function listExportTasks(): Promise<ExportTask[]> {
  return invoke<ExportTask[]>("list_export_tasks");
}

export function cancelExport(taskId: number): Promise<void> {
  return invoke<void>("cancel_export", { taskId });
}

export function onExportProgress(handler: (p: ExportProgress) => void): Promise<UnlistenFn> {
  return on<ExportProgress>("export://progress", handler);
}
