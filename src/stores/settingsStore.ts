/** 应用设置状态：启动加载，保存即落库 */
import { create } from "zustand";
import { getSettings, saveSettings } from "@/api/settings";
import { normalizeSettings } from "@/utils/normalizeSettings";
import { markStartup } from "@/utils/startupMarks";
import type { Appearance, Settings } from "@/types/settings";

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
  /** §8.4 FB2-01/02/08：外观设置的即时预览通道。SettingsPage 编辑草稿时写入，
   *  网格/Viewer 立即消费（等效 applyTheme 语义）；保存成功后由 save() 与已落库值对齐。 */
  previewAppearance: Appearance | null;
  setPreviewAppearance: (a: Appearance | null) => void;
  load: () => Promise<void>;
  save: (s: Settings) => Promise<void>;
}

/** FB2-03 默认外观（与 Rust 端 default_* 对齐）；settings 未加载时用作兜底。 */
export const DEFAULT_APPEARANCE: Appearance = {
  grid: { libraryCellStep: 3, importCellStep: 1, cellAspect: "1:1", cellFit: "cover", matchDominantColor: false },
  hoverPreview: { enabled: true, previewSeconds: 3, inLibraryGrid: true },
  colorStrip: { enabled: true, showInLibraryGrid: false, showInViewer: true, showInImportGrid: false, height: "normal", mode: "ratio", count: 6 },
};

/**
 * 读取当前生效外观：草稿预览优先，其次已落库值，最后编译期默认。
 * 这样 SettingsPage 拖动滑块时网格立刻跟随，而其他页面读到的是已保存值或默认。
 */
export function currentAppearance(s: Settings | null, preview: Appearance | null): Appearance {
  if (preview) return preview;
  return s?.appearance ?? DEFAULT_APPEARANCE;
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
  previewAppearance: null,
  setPreviewAppearance: (a) => set({ previewAppearance: a }),

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
      // FB-03 §9.5：保存后回读 DB 对账（不再只信任本地对象），确保 videoTagging 等字段往返一致
      let reconciled = s;
      try {
        const raw = await getSettings();
        reconciled = normalizeSettings(raw);
      } catch {
        // 回读失败不阻断保存成功（回读是增强对账，非保存前置条件）
        tracingWarn("保存设置回读对账失败，沿用本地值");
      }
      set({ settings: reconciled, saving: false });
      applyTheme(reconciled.theme);
    } catch (e) {
      set({ saving: false });
      throw e;
    }
  },
}));

/** 回读失败仅告警（不把后端异常升级为保存失败） */
function tracingWarn(msg: string) {
  if (import.meta.env?.DEV) console.warn(`[settingsStore] ${msg}`);
}