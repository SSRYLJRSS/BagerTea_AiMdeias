/** 元数据「快捷分桶」→ 统一比较条件（P1A 协议）转换。
 *  旧 MetadataPanel 的 file_size / duration / resolution / taken_month 等分面把离散值
 *  当作 `{key, values}` 传给后端；新协议要求转成 `{key, op, value/values/min/max}`。
 *  这里把每种分面值翻译为等价的比较条件，使普通素材库行为不回归。
 */
import type { MetadataFilter } from "@/types/asset";

const MB = 1024 * 1024;
const MS_SEC = 1000;

/** 单条展示值 → 一条比较条件（多选分面同 key 时由调用方决定如何合并） */
export function bucketToFilter(key: string, label: string): MetadataFilter | null {
  switch (key) {
    case "file_size":
      if (label === "lt_1mb") return { key, op: "lt", value: 1 * MB };
      if (label === "1_10mb") return { key, op: "between", min: 1 * MB, max: 10 * MB };
      if (label === "10_100mb") return { key, op: "between", min: 10 * MB, max: 100 * MB };
      if (label === "gte_100mb") return { key, op: "gte", value: 100 * MB };
      break;
    case "duration":
    case "duration_ms":
      if (label === "lt_10s") return { key: "duration_ms", op: "lt", value: 10 * MS_SEC };
      if (label === "10_60s")
        return { key: "duration_ms", op: "between", min: 10 * MS_SEC, max: 60 * MS_SEC };
      if (label === "1_5m")
        return { key: "duration_ms", op: "between", min: 60 * MS_SEC, max: 300 * MS_SEC };
      if (label === "gte_5m") return { key: "duration_ms", op: "gte", value: 300 * MS_SEC };
      break;
    case "resolution": {
      const m = /^(\d+)x(\d+)$/.exec(label);
      if (m) return { key, op: "eq", value: Number(m[1]) * Number(m[2]) };
      break;
    }
    case "taken_month": {
      const m = /^(\d{4})-(\d{2})$/.exec(label);
      if (m) {
        const month = Number(m[2]);
        const year = Number(m[1]);
        const start = new Date(year, month - 1, 1);
        // 后端日期 between 的 max 语义包含当天，因此上界取当月最后一天。
        const end = new Date(year, month, 0);
        return {
          key: "taken_at",
          op: "between",
          min: isoDate(start),
          max: isoDate(end),
        };
      }
      break;
    }
    case "hue":
      // V18 色调分桶：后端按 dominant_hue 分桶（红色跨 0°），灰度按 dominant_sat<=10 判定。
      // 红色桶 min>max（345~15）由后端环形 between 特判编译为双区间 OR。
      if (label === "gray") return { key: "dominant_sat", op: "lte", value: 10 };
      if (label === "red") return { key: "dominant_hue", op: "between", min: 345, max: 15 };
      if (label === "orange") return { key: "dominant_hue", op: "between", min: 15, max: 45 };
      if (label === "yellow") return { key: "dominant_hue", op: "between", min: 45, max: 70 };
      if (label === "green") return { key: "dominant_hue", op: "between", min: 70, max: 155 };
      if (label === "cyan") return { key: "dominant_hue", op: "between", min: 155, max: 225 };
      if (label === "blue") return { key: "dominant_hue", op: "between", min: 225, max: 295 };
      if (label === "purple") return { key: "dominant_hue", op: "between", min: 295, max: 345 };
      break;
    default:
      // 离散等值分面（camera/lens/iso/…）：eq 单值让后端走 in/eq
      return { key: key as MetadataFilter["key"], op: "eq", value: label };
  }
  return null;
}

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
