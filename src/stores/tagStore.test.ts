/** W3-2：tagStore 契约测试 —— 硬编码分面清单已删，
 *  buildWorkbenchFacets 按 inputMode 分组 + 消费 appliesTo；空 facets 返回空。 */
import { describe, expect, it } from "vitest";
import { buildWorkbenchFacets, normalizeTagKeys, keyForLegacyName } from "@/stores/tagStore";
import type { TagFacet } from "@/types/tag";

const mkFacet = (over: Partial<TagFacet> & Pick<TagFacet, "key">): TagFacet => ({
  displayName: over.key,
  description: "",
  inputMode: "ai_and_manual",
  selectionMode: "multi",
  maxItems: null,
  sortOrder: 0,
  isSystem: false,
  status: "active",
  appliesTo: "all",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const baseFacets: TagFacet[] = [
  mkFacet({ key: "subject", displayName: "主体/对象", maxItems: 5 }),
  mkFacet({ key: "scene", displayName: "场景/地点", maxItems: 3 }),
  mkFacet({ key: "purpose", inputMode: "manual_only" }),
];

describe("W3-2 buildWorkbenchFacets", () => {
  it("_groups_by_input_mode：ai_and_manual 进 AI 组、manual_only 进手工组", () => {
    const { aiGroup, manualGroup } = buildWorkbenchFacets(baseFacets);
    expect(aiGroup.map((f) => f.key)).toEqual(["subject", "scene"]);
    expect(manualGroup.map((f) => f.key)).toEqual(["purpose"]);
    const subject = aiGroup[0];
    expect(subject.displayName).toBe("主体/对象");
    expect(subject.selectionMode).toBe("multi");
    expect(subject.maxItems).toBe(5);
  });

  it("_filters_by_applies_to：video-only 分面不进图片工作台", () => {
    const facets = [
      mkFacet({ key: "subject" }),
      mkFacet({ key: "video_mood", appliesTo: "video" }),
    ];
    const img = buildWorkbenchFacets(facets, "image");
    expect(img.aiGroup.map((f) => f.key)).toEqual(["subject"]);
    const vid = buildWorkbenchFacets(facets, "video");
    expect(vid.aiGroup.map((f) => f.key)).toEqual(["subject", "video_mood"]);
    // all 不筛
    const all = buildWorkbenchFacets(facets, "all");
    expect(all.aiGroup).toHaveLength(2);
  });

  it("_no_hardcoded_fallback：传空 facets 返回空数组（不回退硬编码默认值）", () => {
    const { aiGroup, manualGroup } = buildWorkbenchFacets([]);
    expect(aiGroup).toEqual([]);
    expect(manualGroup).toEqual([]);
  });

  it("停用分面不进任何组", () => {
    const facets = [mkFacet({ key: "gone", status: "inactive" })];
    const { aiGroup, manualGroup } = buildWorkbenchFacets(facets);
    expect(aiGroup).toHaveLength(0);
    expect(manualGroup).toHaveLength(0);
  });
});

describe("keyForLegacyName / normalizeTagKeys", () => {
  it("中文分类名归一化为稳定 facetKey（未知归 custom）", () => {
    expect(keyForLegacyName("场景/地点")).toBe("scene");
    expect(keyForLegacyName("人物属性")).toBe("people");
    expect(keyForLegacyName("可用性/技术特征")).toBe("technical");
    expect(keyForLegacyName("未知分类")).toBe("custom");
  });

  it("normalizeTagKeys：自建分面 key 原样保留（knownFacetKeys）", () => {
    const out = normalizeTagKeys({ clothing_color: ["红色"] }, ["clothing_color", "scene"]);
    expect(out.clothing_color).toEqual(["红色"]);
    expect(out.custom).toBeUndefined();
  });

  it("normalizeTagKeys：中文旧名映射 + 未知归 custom", () => {
    const tags = {
      "场景/地点": ["海边"],
      scene: ["公园"],
      "未知分类": ["某标签"],
      色彩: ["低饱和"],
    };
    const out = normalizeTagKeys(tags, ["scene", "color"]);
    expect(out.scene).toEqual(expect.arrayContaining(["海边", "公园"]));
    expect(out.custom).toEqual(["某标签"]);
    expect(out.color).toEqual(["低饱和"]);
  });
});
