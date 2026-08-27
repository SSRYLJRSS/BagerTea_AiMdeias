/** 应用设置状态：启动加载，保存即落库 */
import { create } from "zustand";
import { getSettings, saveSettings } from "@/api/settings";
import { normalizeSettings } from "@/utils/normalizeSettings";
import { markStartup } from "@/utils/startupMarks";
import type { Settings } from "@/types/settings";

/** R-24：主题写入 <html> 的 data-theme（system 时 media query 接管，light/dark 显式生效） */
export function applyTheme(theme: Settings["theme"]) {
  document.documentElement.dataset.theme = theme;
}

interface SettingsState {
  settings: Settings | null;
  loaded: boolean;
  /** 正在加载/重试：指导书 阶段 1 §6.3 状态机（idle → loading → ready/error）。 */
  loading: boolean;
  loadError: string | null; // B28：新增——加载失败时暴露错误，前端可据此禁用保存防覆盖
  saving: boolean;
  load: () => Promise<void>;
  save: (s: Settings) => Promise<void>;
}

/**
 * single-flight（指导书 §5.3）：并发调用只产生一次底层请求。
 * App / SettingsPage 等多处「未 loaded 就 load()」的调用共享同一 Promise；
 * 失败后（loadError 非空）允许重试，仍走单飞去重。
 */
let loadPromise: Promise<void> | null = null;

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: null,
  loaded: false,
  loading: false,
  loadError: null,
  saving: false,

  load: () => {
    const s = get();
    // 已成功加载：直接完成；加载失败（loadError）允许重试
    if (s.loaded && !s.loadError) return Promise.resolve();
    if (loadPromise) return loadPromise;
    set({ loading: true, loadError: null });
    loadPromise = (async () => {
      try {
        const raw = await getSettings();
        // A-2：后端返回先做运行时归一化（缺字段兜底），再写入 store，避免 SettingsPage 因缺字段白屏
        const settings = normalizeSettings(raw);
        set({ settings, loaded: true, loading: false, loadError: null });
        applyTheme(settings.theme); // R-24：启动即应用已保存主题
        markStartup("settings_ready"); // §4.1：设置 ready 打点
      } catch (e) {
        // B28：暴露错误状态而非静默吞错（后端异常时用户看到默认设置页，保存后可能覆盖真实配置）
        set({ loaded: true, loading: false, loadError: e instanceof Error ? e.message : String(e) });
      } finally {
        loadPromise = null;
      }
    })();
    return loadPromise;
  },

  save: async (s) => {
    set({ saving: true });
    try {
      await saveSettings(s);
      set({ settings: s, saving: false });
      applyTheme(s.theme);
    } catch (e) {
      set({ saving: false });
      throw e;
    }
  },
}));