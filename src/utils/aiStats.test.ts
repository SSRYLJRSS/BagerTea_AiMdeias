/**
 * computeAiStats 测试（指导书 B-1 / B-5）：「全部确认」按钮绑定待确认建议数。
 */
import { describe, expect, it } from "vitest";
import { computeAiStats, estimateRequests } from "@/utils/aiStats";

describe("computeAiStats", () => {
  it("空建议返回全 0", () => {
    expect(computeAiStats([])).toEqual({
      total: 0, awaitingGeneration: 0, awaitingConfirmation: 0, confirmed: 0, failed: 0, videoCount: 0,
    });
  });

  it("pending 且 SuggestedTags 为空 = 待生成；非空 = 待确认", () => {
    const stats = computeAiStats([
      { status: "pending", suggestedTags: {} },
      { status: "pending", suggestedTags: { subject: ["人"] } },
    ]);
    expect(stats.awaitingGeneration).toBe(1);
    expect(stats.awaitingConfirmation).toBe(1);
    expect(stats.total).toBe(2);
  });

  it("confirmed 与 rejected 分别计入已确认/失败", () => {
    const stats = computeAiStats([
      { status: "confirmed", suggestedTags: { scene: ["海边"] } },
      { status: "rejected", suggestedTags: {} },
      { status: "pending", suggestedTags: { color: ["蓝"] } },
    ]);
    expect(stats.confirmed).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.awaitingConfirmation).toBe(1);
    expect(stats.awaitingGeneration).toBe(0);
  });

  it("「全部确认」按钮应显示 awaitingConfirmation 数量", () => {
    const stats = computeAiStats([
      { status: "pending", suggestedTags: { style: ["胶片"] } },
      { status: "pending", suggestedTags: { subject: ["狗"] } },
    ]);
    expect(stats.awaitingConfirmation).toBe(2);
  });

  it("FB2-07：统计 videoCount，estimateRequests 按模式折算请求数", () => {
    const stats = computeAiStats([
      { status: "pending", suggestedTags: {}, mimeType: "video/mp4" },
      { status: "pending", suggestedTags: {}, mimeType: "video/quicktime" },
      { status: "pending", suggestedTags: {}, mimeType: "image/jpeg" },
    ]);
    expect(stats.videoCount).toBe(2);
    expect(stats.total).toBe(3);
    // 3 = 1 张图片 + 2 视频 × cover(1)
    expect(estimateRequests(stats, "cover", 3)).toBe(3);
    // 7 = 1 + 2 × frames(3)
    expect(estimateRequests(stats, "frames", 3)).toBe(7);
  });
});

describe("W0-4 modified 计入已确认", () => {
  it("modified 状态计为已确认，不再从批次统计里消失", () => {
    const stats = computeAiStats([
      { status: "confirmed", suggestedTags: { scene: ["海边"] } },
      { status: "modified", suggestedTags: { subject: ["人"] } },
      { status: "rejected", suggestedTags: {} },
    ]);
    expect(stats.confirmed).toBe(2);
    expect(stats.failed).toBe(1);
    expect(stats.total).toBe(3);
  });
});
