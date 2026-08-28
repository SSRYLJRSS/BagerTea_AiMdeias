/**
 * AI 批次统计纯函数（指导书 B-1）：待生成 / 待确认 / 已确认 / 失败 分开统计。
 * 「全部确认」必须用「待确认建议」数量（awaitingConfirmation），不能混用待生成数。
 * FB2-07（§13.6）：新增 videoCount（用于预估请求次数），estimateRequests 按模式算。
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
  /** FB2-07：批次内视频数（图片按 1 次/张，视频按模式 1 或 N 次） */
  videoCount: number;
}

interface StatEntry {
  status: string;
  suggestedTags: Record<string, string[]>;
  /** PB2-07：若条目能识别出是否视频（suggestion 带 mimeType/path），用于统计 videoCount */
  mimeType?: string | null;
  filePath?: string;
}

/** 计算批次统计：状态语义清晰，让「全部确认」按钮绑定待确认建议数。 */
export function computeAiStats(suggestions: StatEntry[]): AiStats {
  const total = suggestions.length;
  let awaitingGeneration = 0;
  let awaitingConfirmation = 0;
  let confirmed = 0;
  let failed = 0;
  let videoCount = 0;
  for (const s of suggestions) {
    if (s.mimeType?.startsWith("video/") || isVideoPath(s.filePath)) videoCount += 1;
    if (s.status === "pending") {
      if (Object.keys(s.suggestedTags).length === 0) awaitingGeneration += 1;
      else awaitingConfirmation += 1;
    } else if (s.status === "confirmed") {
      confirmed += 1;
    } else if (s.status === "rejected") {
      failed += 1;
    }
  }
  return { total, awaitingGeneration, awaitingConfirmation, confirmed, failed, videoCount };
}

const VIDEO_EXT_RE = /\.(mp4|mov|avi|mkv|webm|m4v|wmv|flv|mpg|mpeg|3gp|ts|rm|rmvb)$/i;
function isVideoPath(p?: string): boolean {
  return !!p && VIDEO_EXT_RE.test(p);
}

/** FB7-07：预估本批次请求次数 —— 图片 1 次/张；视频按模式（cover=1，frames=N）。 */
export function estimateRequests(stats: AiStats, mode: "cover" | "frames", frameCount: number): number {
  const images = stats.total - stats.videoCount;
  return images + stats.videoCount * (mode === "frames" ? frameCount : 1);
}
