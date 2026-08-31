/** 打标审核中一句话描述的展示优先级（FB5-05 §7.6 + FX-03）：
 *  确认值 → 素材当前值 → AI 建议值。
 *  FX-03：后端把「素材无描述」序列化为空串（非 null），?? 只跳过 null 不跳过空串，
 *  会把 AI 建议值挡住（打标页描述框永远空）。这里统一按「非空」取值。
 */
export function pickReviewDescription(s: {
  confirmedDescription?: string | null;
  currentDescription?: string;
  suggestedDescription?: string;
}): string {
  const nonEmpty = (v?: string | null) => (v ?? "").trim();
  return (
    nonEmpty(s.confirmedDescription) ||
    nonEmpty(s.currentDescription) ||
    nonEmpty(s.suggestedDescription)
  );
}
