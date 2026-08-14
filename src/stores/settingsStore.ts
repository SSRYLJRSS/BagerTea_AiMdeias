/** 应用设置状态：启动加载，保存即落库 */
import { create } from "zustand";
import { getSettings, saveSettings } from "@/api/settings";
import type { Settings } from "@/types/settings";

interface SettingsState {
  settings: Settings | null;
  loaded: boolean;
  loadError: string | null; // B28：新增——加载失败时暴露错误，前端可据此禁用保存防覆盖
  saving: boolean;
  load: () => Promise<void>;
  save: (s: Settings) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  loaded: false,
  loadError: null,
  saving: false,

  load: async () => {
    try {
      const settings = await getSettings();
      set({ settings, loaded: true, loadError: null });
    } catch (e) {
      // B28：暴露错误状态而非静默吞错（后端异常时用户看到默认设置页，保存后可能覆盖真实配置）
      set({ loaded: true, loadError: e instanceof Error ? e.message : String(e) });
    }
  },

  save: async (s) => {
    set({ saving: true });
    try {
      await saveSettings(s);
      set({ settings: s, saving: false });
    } catch (e) {
      set({ saving: false });
      throw e;
    }
  },
}));
