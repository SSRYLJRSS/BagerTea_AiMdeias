/** 入库相关命令封装（对应 commands/import_cmd.rs） */
import { invoke, on } from "./client";
import type { ImportResult } from "@/types/asset";
import type { UnlistenFn } from "@tauri-apps/api/event";

export interface ImportProgress {
  current: number;
  total: number;
  file: string;
}

export interface ImportOptions {
  /** 分库名称（总库下新建子文件夹，R-32） */
  collection?: string;
  /** 批量改名模板：{分库} {原名} {日期} {序号} {序号:N}；空 = 不改名 */
  renamePattern?: string;
}

export function importFiles(paths: string[], opts: ImportOptions = {}): Promise<ImportResult> {
  return invoke<ImportResult>("import_files", {
    paths,
    collection: opts.collection,
    renamePattern: opts.renamePattern,
  });
}

/** 前端预览用：与后端 render_name 同规则（日期以今天示意） */
export function renderNamePreview(template: string, collection: string, origStem: string, seq = 1): string {
  const date = new Date();
  const ymd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
  let out = template.replace(/\{序号:(\d+)\}/, (_, w) => String(seq).padStart(Number(w), "0"));
  out = out
    .replaceAll("{分库}", collection)
    .replaceAll("{原名}", origStem)
    .replaceAll("{日期}", ymd)
    .replaceAll("{序号}", String(seq));
  out = out.replace(/[<>:"/\\|?*]/g, "_").replace("..", "_").trim().replace(/^\.+|\.+$/g, "");
  return out || origStem;
}

export function cancelImport(): Promise<void> {
  return invoke<void>("cancel_import");
}

export interface ImportPlanItem {
  path: string;
  kind: "image" | "video";
  size: number;
}

export interface ImportPlan {
  items: ImportPlanItem[];
  images: number;
  videos: number;
  totalSize: number;
}

/** 扫描路径生成待入库清单（不落库，两段式入库用） */
export function inspectImport(paths: string[]): Promise<ImportPlan> {
  return invoke<ImportPlan>("inspect_import", { paths });
}

export function onImportProgress(handler: (p: ImportProgress) => void): Promise<UnlistenFn> {
  return on<ImportProgress>("import://progress", handler);
}
