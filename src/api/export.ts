/** 导出相关命令封装（对应 commands/export_cmd.rs） */
import { invoke, on } from "./client";
import type { ExportTask } from "@/types/export";
import type { UnlistenFn } from "@tauri-apps/api/event";

export interface ExportProgress {
  taskId: number;
  done: number;
  total: number;
}

/** R-26 子目录组织：flat 平铺 | by_tag 按首个标签 | by_date 按拍摄月份 */
export type ExportLayout = "flat" | "by_tag" | "by_date";

export function exportLocalFiles(
  assetIds: number[],
  destDir: string,
  mode: "copy" | "move",
  layout: ExportLayout = "flat",
): Promise<ExportTask> {
  return invoke<ExportTask>("export_local_files", { assetIds, destDir, mode, layout });
}

/** R-26 CSV 清单导出：返回清单文件路径（UTF-8 BOM，Excel 直开） */
export function exportCsvManifest(assetIds: number[], destDir: string): Promise<string> {
  return invoke<string>("export_csv_manifest", { assetIds, destDir });
}

export function onExportProgress(handler: (p: ExportProgress) => void): Promise<UnlistenFn> {
  return on<ExportProgress>("export://progress", handler);
}
