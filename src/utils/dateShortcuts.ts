/** U-7 ②：日期快捷边界（本地时区，周一为一周起点）。
 *  返回 YYYY-MM-DD 字符串 —— 后端日期条件只收字符串（MetadataFilter.value/min/max，
 *  拍摄/入库/修改时间编译时按本地零点处理）；AI 路径与手工路径同格式，旧 epoch 数字不再产出。
 *  可注入 now 便于测试断言（默认取当前时间）。 */
export type DateShortcutKind = "today" | "thisWeek" | "thisMonth" | "thisYear";

export const DATE_SHORTCUT_OPTIONS: { kind: DateShortcutKind; label: string }[] = [
  { kind: "today", label: "今天" },
  { kind: "thisWeek", label: "本周" },
  { kind: "thisMonth", label: "本月" },
  { kind: "thisYear", label: "今年" },
];

const DAY_MS = 86_400_000;

function startOfDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** Date → 本地时区 YYYY-MM-DD（不用 toISOString —— 那是 UTC，跨时区会偏移一天）。 */
export function toIsoDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 快捷期起点：今天=当天；本周=周一；本月=1 号；今年=1 月 1 日。返回 YYYY-MM-DD。 */
export function shortcutStartMs(kind: DateShortcutKind, now: Date = new Date()): string {
  const day = startOfDay(now);
  switch (kind) {
    case "today":
      return toIsoDateString(day);
    case "thisWeek": {
      const back = (now.getDay() + 6) % 7; // 周一起点（getDay: 0=周日）
      return toIsoDateString(new Date(day.getTime() - back * DAY_MS));
    }
    case "thisMonth":
      return toIsoDateString(new Date(now.getFullYear(), now.getMonth(), 1));
    case "thisYear":
      return toIsoDateString(new Date(now.getFullYear(), 0, 1));
  }
}

/** 快捷期终点（当天/周日/月末/年末，含全天）：lte/max 侧写这个日期，
 *  后端对「不晚于 D」自动含 D 全天，无需把终点推到 23:59。返回 YYYY-MM-DD。 */
export function shortcutEndMs(kind: DateShortcutKind, now: Date = new Date()): string {
  switch (kind) {
    case "thisWeek": {
      const start = new Date(`${shortcutStartMs("thisWeek", now)}T00:00:00`);
      return toIsoDateString(new Date(start.getTime() + 6 * DAY_MS));
    }
    case "thisMonth":
      return toIsoDateString(new Date(now.getFullYear(), now.getMonth() + 1, 0));
    case "thisYear":
      return toIsoDateString(new Date(now.getFullYear() + 1, 0, 0));
    case "today":
      return shortcutStartMs("today", now);
  }
}
