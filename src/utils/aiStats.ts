/**
 * AI 批次统计纯函数（指导书 B-1）：待生成 / 待确认 / 已确认 / 失败 分开统计。
 * 「全部确认」必须用「待确认建议」数量（awaitingConfirmation），不能混用待生成数。
 */
export interface AiStats {
  total: number;
  /** 待生成：pending 且尚无 AI 建议（suggestedTags 为空） */
  awaitingGeneration: number;
  /** 待确认：pending 且已有 AI 建议（suggestedTags 非空），可「全部确认」 */
  awaitingConfirmation: number;
  /** 已确认 */
  confirmed: number;
  /** 失败/已拒绝 */
  failed: number;
}

interface StatEntry {
  status: string;
  suggestedTags: Record<string, string[]>;
}

/** 计算批次统计：状态语义清晰，让「全部确认」按钮绑定待确认建议数。 */
export function computeAiStats(suggestions: StatEntry[]): AiStats {
  const total = suggestions.length;
  let awaitingGeneration = 0;
  let awaitingConfirmation = 0;
  let confirmed = 0;
  let failed = 0;
  for (const s of suggestions) {
    if (s.status === "pending") {
      if (Object.keys(s.suggestedTags).length === 0) awaitingGeneration += 1;
      else awaitingConfirmation += 1;
    } else if (s.status === "confirmed") {
      confirmed += 1;
    } else if (s.status === "rejected") {
      failed += 1;
    }
  }
  return { total, awaitingGeneration, awaitingConfirmation, confirmed, failed };
}
