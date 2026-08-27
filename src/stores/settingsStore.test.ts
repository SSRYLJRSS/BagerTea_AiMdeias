/**
 * settingsStore 测试（指导书 阶段 1 §5.3/§13.1）：
 *  - load() single-flight：并发调用只产生一个底层 getSettings 请求；
 *  - 加载失败可重试（loadError 非空时再次 load 允许发出新请求）；
 *  - 失败不写入默认设置覆盖真实配置（settings 保持 null，loadError 暴露）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSettings } from "@/api/settings";
import { useSettingsStore, applyTheme } from "@/stores/settingsStore";
import type { Settings } from "@/types/settings";

vi.mock("@/api/settings", () => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn().mockResolvedValue(undefined),
}));

function mkSettings(): Settings {
  return {
    ai: {
      profiles: [],
      activeProfile: "",
      autoTagging: false,
      videoTagging: false,
      localModelTier: "light",
      batchLimit: 500,
      ollamaSourceId: "auto",
    },
    theme: "light",
    thumbnailCacheMb: 2048,
    tagCategories: [],
    aiFacetConfigs: [],
    libraryRoot: "",
    trashRetentionDays: 30,
    customDownloadSources: [],
    modelDownloadProxy: "",
  };
}

const emptyStore = {
  settings: null,
  loaded: false,
  loading: false,
  loadError: null,
  saving: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState(emptyStore);
  document.documentElement.dataset.theme = "";
});

describe("settingsStore §5.3 single-flight", () => {
  it("并发调用只产生一个 getSettings 请求", async () => {
    let resolveFn: (s: Settings) => void = () => {};
    vi.mocked(getSettings).mockReturnValue(new Promise<Settings>((r) => (resolveFn = r)));

    // 两个并发 load（App + SettingsPage 同时首挂）
    const p1 = useSettingsStore.getState().load();
    const p2 = useSettingsStore.getState().load();

    expect(vi.mocked(getSettings)).toHaveBeenCalledTimes(1);
    resolveFn(mkSettings());
    await Promise.all([p1, p2]);
    expect(vi.mocked(getSettings)).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().loaded).toBe(true);
    expect(useSettingsStore.getState().settings?.theme).toBe("light");
  });

  it("已加载成功后再 load 不再发请求", async () => {
    vi.mocked(getSettings).mockResolvedValue(mkSettings());
    await useSettingsStore.getState().load();
    expect(vi.mocked(getSettings)).toHaveBeenCalledTimes(1);

    await useSettingsStore.getState().load();
    expect(vi.mocked(getSettings)).toHaveBeenCalledTimes(1);
  });

  it("加载失败暴露 loadError（不写默认设置覆盖），点击重试后再 load 可成功", async () => {
    vi.mocked(getSettings)
      .mockRejectedValueOnce(new Error("后端未连接"))
      .mockResolvedValueOnce(mkSettings());
    useSettingsStore.getState().load();
    await new Promise((r) => setTimeout(r, 0)); // flush 微任务
    await vi.waitFor(() => {
      const s = useSettingsStore.getState();
      expect(s.loaded).toBe(true);
      expect(s.loadError).toBe("后端未连接");
      expect(s.settings).toBeNull(); // 失败不写默认设置覆盖真实配置
    });

    // 重试：loadError 非空 → 允许再次 load
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().settings?.theme).toBe("light");
    expect(useSettingsStore.getState().loadError).toBeNull();
    expect(vi.mocked(getSettings)).toHaveBeenCalledTimes(2);
  });

  it("成功加载后应用主题（applyTheme）", async () => {
    vi.mocked(getSettings).mockResolvedValue(mkSettings());
    await useSettingsStore.getState().load();
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});

describe("applyTheme", () => {
  it("写入 html data-theme（非 Tauri 环境同用）", () => {
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    applyTheme("system");
    expect(document.documentElement.dataset.theme).toBe("system");
  });
});