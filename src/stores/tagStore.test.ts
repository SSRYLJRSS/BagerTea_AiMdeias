import { describe, expect, it } from "vitest";
import { buildWorkbenchFacets, normalizeTagKeys, keyForLegacyName } from "@/stores/tagStore";
import type { TagFacet } from "@/types/tag";
import type { AiFacetConfig } from "@/types/settings";

const baseFacets: TagFacet[] = [
  { key: "subject", displayName: "主体/对象", description: "照片主体", selectionMode: "multi", maxItems: 5, sortOrder: 1, isSystem: true, status: "active" },
  { key: "scene", displayName: "场景/地点", description: "拍摄场景", selectionMode: "multi", maxItems: 3, sortOrder: 2, isSystem: true, status: "active" },
];

describe("buildWorkbenchFacets（指导书 §9.2/§9.3）", () => {
  it("tag_facets 决定分面结构与默认显示名/描述/single/max", () => {
    const out = buildWorkbenchFacets(baseFacets, []);
    const subject = out.find((f) => f.key === "subject")!;
    expect(subject.displayName).toBe("主体/对象");
    expect(subject.selectionMode).toBe("multi");
    expect(subject.maxItems).toBe(5);
    expect(subject.enabledForAi).toBe(true);
    expect(subject.hint).toBe("");
  });

  it("工作台默认只显示用户要求的 7 个分面（purpose/technical/custom 默认隐藏）", () => {
    const out = buildWorkbenchFacets([], []);
    const keys = out.map((f) => f.key);
    expect(keys).toEqual([
      "subject", "scene", "style", "color", "composition", "lighting", "people",
    ]);
    expect(out.find((f) => f.key === "custom")).toBeUndefined();
    expect(out.find((f) => f.key === "purpose")).toBeUndefined();
    expect(out.find((f) => f.key === "technical")).toBeUndefined();
  });

  it("显式设置 visibleInWorkbench 可覆盖默认显隐", () => {
    const configs: AiFacetConfig[] = [
      { facetKey: "purpose", hint: "", enabledForAi: true, visibleInWorkbench: true },
      { facetKey: "subject", hint: "", enabledForAi: true, visibleInWorkbench: false },
    ];
    const out = buildWorkbenchFacets(baseFacets, configs);
    expect(out.find((f) => f.key === "purpose")).toBeDefined();
    expect(out.find((f) => f.key === "subject")).toBeUndefined();
  });

  it("aiFacetConfigs 覆盖 enabledForAi / hint / 显示名，但不改变 facetKey", () => {
    const configs: AiFacetConfig[] = [
      { facetKey: "subject", hint: "识别图片主角", enabledForAi: false, displayName: "主体" },
    ];
    const out = buildWorkbenchFacets(baseFacets, configs);
    const subject = out.find((f) => f.key === "subject")!;
    expect(subject.key).toBe("subject");
    expect(subject.displayName).toBe("主体");
    expect(subject.hint).toBe("识别图片主角");
    expect(subject.enabledForAi).toBe(false);
    // 无配置分面保持默认
    const scene = out.find((f) => f.key === "scene")!;
    expect(scene.enabledForAi).toBe(true);
    expect(scene.hint).toBe("");
    expect(scene.displayName).toBe("场景/地点");
  });

  it("空 displayName 覆盖回退到 tag_facets 默认", () => {
    const configs: AiFacetConfig[] = [{ facetKey: "subject", hint: "h", enabledForAi: true, displayName: "  " }];
    const out = buildWorkbenchFacets(baseFacets, configs);
    expect(out.find((f) => f.key === "subject")!.displayName).toBe("主体/对象");
  });
});

describe("keyForLegacyName / normalizeTagKeys", () => {
  it("中文分类名归一化为稳定 facetKey（未知归 custom）", () => {
    expect(keyForLegacyName("场景/地点")).toBe("scene");
    expect(keyForLegacyName("人物属性")).toBe("people");
    expect(keyForLegacyName("可用性/技术特征")).toBe("technical");
    expect(keyForLegacyName("未知分类")).toBe("custom");
  });

  it("normalizeTagKeys 把显示名 key 归一化并合并重复", () => {
    const tags = {
      "场景/地点": ["海边"],
      scene: ["公园"],
      "未知分类": ["某标签"],
      色彩: ["低饱和"],
    };
    const out = normalizeTagKeys(tags);
    expect(out.scene).toEqual(expect.arrayContaining(["海边", "公园"]));
    expect(out.custom).toEqual(["某标签"]);
    expect(out.color).toEqual(["低饱和"]);
  });
});
