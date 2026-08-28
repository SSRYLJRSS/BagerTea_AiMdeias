/**
 * normalizeSettings 测试（指导书 A-2 / A-4）：后端缺失字段时安全兜底，不白屏。
 */
import { describe, expect, it } from "vitest";
import { normalizeSettings } from "@/utils/normalizeSettings";
import { DEFAULT_BATCH_LIMIT, DEFAULT_CACHE_MB, DEFAULT_MODEL } from "@/utils/normalizeSettings";

describe("normalizeSettings", () => {
  it("对完全缺失的输入返回全默认值", () => {
    const s = normalizeSettings(undefined);
    expect(s.theme).toBe("system");
    expect(s.ai.profiles).toEqual([]);
    expect(s.ai.videoTagging).toBe(false);
    expect(s.ai.batchLimit).toBe(DEFAULT_BATCH_LIMIT);
    expect(s.ai.activeProfile).toBe("");
    expect(s.aiFacetConfigs).toEqual([]);
    expect(s.tagCategories).toEqual([]);
    expect(s.customDownloadSources).toEqual([]);
    expect(s.libraryRoot).toBe("");
    expect(s.trashRetentionDays).toBe(30);
    expect(s.thumbnailCacheMb).toBe(DEFAULT_CACHE_MB);
  });

  it("null / 非对象输入兜底为默认", () => {
    const s = normalizeSettings(null);
    expect(s.theme).toBe("system");
    const s2 = normalizeSettings(42);
    expect(s2.ai.profiles).toEqual([]);
  });

  it("缺少 ai 字段时提供安全默认（SettingsPage 不会访问 undefined.ai）", () => {
    const s = normalizeSettings({ theme: "light", libraryRoot: "/x" });
    expect(s.ai).toBeDefined();
    expect(s.ai.videoTagging).toBe(false);
    expect(s.theme).toBe("light");
    expect(s.libraryRoot).toBe("/x");
  });

  it("normalize profile 字段：缺省 model 用默认，kind apiMode 兜底", () => {
    const s = normalizeSettings({
      ai: {
        profiles: [{ id: "p1", name: "A" }],
        activeProfile: "p1",
        videoTagging: true,
        batchLimit: 30,
      },
    });
    expect(s.ai.profiles).toHaveLength(1);
    expect(s.ai.profiles[0].model).toBe(DEFAULT_MODEL);
    expect(s.ai.profiles[0].apiMode).toBe("openai");
    expect(s.ai.profiles[0].kind).toBe("cloud");
    expect(s.ai.activeProfile).toBe("p1");
    expect(s.ai.videoTagging).toBe(true);
    expect(s.ai.batchLimit).toBe(30);
  });

  it("activeProfile 指向不存在配置时回退为空（SettingsPage 会回退到第一套）", () => {
    const s = normalizeSettings({
      ai: { profiles: [{ id: "p1" }], activeProfile: "ghost" },
    });
    expect(s.ai.activeProfile).toBe("");
  });

  it("保留合法的 aiFacetConfigs，非法/空 key 被过滤", () => {
    const s = normalizeSettings({
      aiFacetConfigs: [
        { facetKey: "color", hint: "主色调", enabledForAi: true },
        { facetKey: "" },
        null,
      ],
    });
    expect(s.aiFacetConfigs).toHaveLength(1);
    expect(s.aiFacetConfigs[0].facetKey).toBe("color");
    expect(s.aiFacetConfigs[0].enabledForAi).toBe(true);
  });

  it("畸形数字/布尔字段兜底", () => {
    const s = normalizeSettings({
      theme: "system",
      thumbnailCacheMb: -5,
      trashRetentionDays: -1,
      ai: { batchLimit: 0 },
    });
    expect(s.thumbnailCacheMb).toBe(0);
    expect(s.trashRetentionDays).toBe(0);
    expect(s.ai.batchLimit).toBe(1);
  });

  it("未知 theme 值回退 system", () => {
    expect(normalizeSettings({ theme: "blue" }).theme).toBe("system");
  });

  it("FB2-01：appearance 完全缺失 → 全默认（hoverEnabled 默认 true）", () => {
    const s = normalizeSettings(undefined);
    expect(s.appearance.grid.libraryCellStep).toBe(3);
    expect(s.appearance.grid.importCellStep).toBe(1);
    expect(s.appearance.grid.cellAspect).toBe("1:1");
    expect(s.appearance.grid.cellFit).toBe("cover");
    expect(s.appearance.grid.matchDominantColor).toBe(false);
    expect(s.appearance.hoverPreview.enabled).toBe(true);
    expect(s.appearance.hoverPreview.previewSeconds).toBe(3);
    expect(s.appearance.hoverPreview.inLibraryGrid).toBe(true);
    expect(s.appearance.colorStrip.enabled).toBe(true);
    expect(s.appearance.colorStrip.count).toBe(6);
  });

  it("FB2-01：非法 cellAspect → 回落 1:1；cellStep 越界 → 钳制", () => {
    const s = normalizeSettings({
      appearance: {
        grid: { libraryCellStep: 99, importCellStep: -3, cellAspect: "oops", cellFit: "stretch" },
      },
    });
    expect(s.appearance.grid.libraryCellStep).toBe(7);
    expect(s.appearance.grid.importCellStep).toBe(0);
    expect(s.appearance.grid.cellAspect).toBe("1:1");
    expect(s.appearance.grid.cellFit).toBe("cover");
  });

  it("FB2-03：previewSeconds=99 → 钳制 10；hoverPreview.enabled 缺失 → true", () => {
    const s = normalizeSettings({
      appearance: { hoverPreview: { previewSeconds: 99 } },
    });
    expect(s.appearance.hoverPreview.previewSeconds).toBe(10);
    expect(s.appearance.hoverPreview.enabled).toBe(true);
  });

  it("FB2-07：videoTaggingMode 非法 → cover；videoFrameCount 钳制 2..=8", () => {
    const s = normalizeSettings({
      ai: { videoTaggingMode: "bad", videoFrameCount: 99, videoTagging: true },
    });
    expect(s.ai.videoTaggingMode).toBe("cover");
    expect(s.ai.videoFrameCount).toBe(8);
  });
});
