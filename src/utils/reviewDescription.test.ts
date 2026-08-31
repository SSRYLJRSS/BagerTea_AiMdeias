/**
 * 打标审核一句话描述取值优先级（FX-03 回归）：
 * 线上事故：currentDescription 为空串（素材无描述），?? 链不跳过空串，
 * AI 建议描述永远显示不出来。正确行为：按「非空」取 确认值 → 当前值 → 建议值。
 */
import { describe, expect, it } from "vitest";
import { pickReviewDescription } from "@/utils/reviewDescription";

describe("pickReviewDescription（FX-03）", () => {
  it("素材无描述（currentDescription 空串）时回退到 AI 建议值", () => {
    const got = pickReviewDescription({
      confirmedDescription: null,
      currentDescription: "",
      suggestedDescription: "女孩自拍",
    });
    expect(got).toBe("女孩自拍");
  });

  it("优先级：确认值 > 素材当前值 > 建议值", () => {
    expect(
      pickReviewDescription({
        confirmedDescription: "确认值",
        currentDescription: "当前值",
        suggestedDescription: "建议值",
      }),
    ).toBe("确认值");
    expect(
      pickReviewDescription({
        confirmedDescription: null,
        currentDescription: "当前值",
        suggestedDescription: "建议值",
      }),
    ).toBe("当前值");
  });

  it("素材已有描述优先于本次建议（不覆盖语义）", () => {
    expect(
      pickReviewDescription({
        currentDescription: "用户已写好的描述",
        suggestedDescription: "AI 新建议",
      }),
    ).toBe("用户已写好的描述");
  });

  it("全空时返回空串；空白串视为空", () => {
    expect(pickReviewDescription({})).toBe("");
    expect(
      pickReviewDescription({
        currentDescription: "  ",
        suggestedDescription: "　",
      }),
    ).toBe("");
  });
});
