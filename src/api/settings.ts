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
