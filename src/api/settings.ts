/** 设置相关命令封装（对应 commands/settings_cmd.rs） */
import { invoke } from "./client";
import type { Settings } from "@/types/settings";

export function getSettings(): Promise<Settings> {
  return invoke<Settings>("get_settings");
}

export function saveSettings(s: Settings): Promise<void> {
  return invoke<void>("save_settings", { s });
}

/** 软件数据保存位置（R-33） */
export function getDataDir(): Promise<string> {
  return invoke<string>("get_data_dir");
}

/** 在系统文件管理器中打开数据目录 */
export function openDataDir(): Promise<void> {
  return invoke<void>("open_data_dir");
}

/** 手动清除缩略图缓存（R-33） */
export { clearThumbnailCache } from "./thumbnail";

/** 重置数据勾选项（对应后端 ResetSelection；false = 保留） */
export interface ResetDataSelection {
  /** 素材库记录（含搜索索引、导出任务；同时清缩略图/预览/代理缓存文件） */
  assets: boolean;
  /** 标签与分类 */
  tags: boolean;
  /** AI 打标任务 */
  aiTasks: boolean;
  /** AI 服务配置（含系统凭据中的密钥） */
  aiConnections: boolean;
  /** 偏好设置（恢复默认） */
  preferences: boolean;
  /** 缓存文件 */
  caches: boolean;
}

/** 重置结果报告（对应后端 ResetReport） */
export interface ResetDataReport {
  assetsDeleted: number;
  tagsDeleted: number;
  aiTasksDeleted: number;
  connectionsDeleted: number;
  preferencesReset: boolean;
  cacheFilesDeleted: number;
}

/** 分类重置应用数据（设置页「数据与缓存 → 重置数据」） */
export function resetAppData(selection: ResetDataSelection): Promise<ResetDataReport> {
  return invoke<ResetDataReport>("reset_app_data", { selection });
}
