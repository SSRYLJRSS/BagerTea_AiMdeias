/** U-7 ②：日期快捷边界（本地时区，周一为一周起点）。
 *  返回 epoch ms —— 与 QueryBuilder 的 dateToEpoch 单位一致（拍摄/入库/修改时间均按本地零点落库）。
 *  可注入 now 便于测试断言（默认取当前时间）。 */
export type DateShortcutKind = "today" | "thisWeek" | "thisMonth" | "thisYear";

export const DATE_SHORTCUT_OPTIONS: { kind: DateShortcutKind; label: string }[] = [
  { kind: "today", label: "今天" },
  { kind: "thisWeek", label: "本周" },
  { kind: "thisMonth", label: "本月" },
  { kind: "thisYear", label: "今年" },
];

const DAY_MS = 86_400_000;

function startOfDayMs(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** 快捷期起点：今天=本地零点；本周=周一零点；本月=1 号零点；今年=1 月 1 日零点。 */
export function shortcutStartMs(kind: DateShortcutKind, now: Date = new Date()): number {
  const day = startOfDayMs(now);
  switch (kind) {
    case "today":
      return day;
    case "thisWeek": {
      const back = (now.getDay() + 6) % 7; // 周一起点（getDay: 0=周日）
      return day - back * DAY_MS;
    }
    case "thisMonth":
      return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    case "thisYear":
      return new Date(now.getFullYear(), 0, 1).getTime();
  }
}

/** 快捷期终点：当天 23:59:59.999（开区间上界，保证 gte/lte 都能含住整日）。 */
export function shortcutEndMs(kind: DateShortcutKind, now: Date = new Date()): number {
  switch (kind) {
    case "thisWeek":
      return shortcutStartMs("thisWeek", now) + 7 * DAY_MS - 1;
    case "thisMonth":
      return new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime() - 1;
    case "thisYear":
      return new Date(now.getFullYear() + 1, 0, 1).getTime() - 1;
    case "today":
      return shortcutStartMs("today", now) + DAY_MS - 1;
  }
}
