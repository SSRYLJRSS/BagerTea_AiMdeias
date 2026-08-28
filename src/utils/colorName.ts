/**
 * FB2-08：hue/sat/lum → 中文色名。仅用于色条无障碍标签与 hover 文案，不参与任何逻辑判断（§14.10）。
 */
const HUE_NAMES: [number, string][] = [
  [15, "红"],
  [45, "橙"],
  [70, "黄"],
  [90, "黄绿"],
  [155, "绿"],
  [185, "青绿"],
  [225, "青"],
  [255, "天蓝"],
  [295, "蓝"],
  [320, "紫"],
  [345, "品红"],
  [360, "玫红"],
];

function hueName(hue: number): string {
  const h = ((hue % 360) + 360) % 360;
  for (const [end, name] of HUE_NAMES) {
    if (h < end) return name;
  }
  return "红";
}

/** hue/sat/lum → 中文色名。sat<10 归灰阶；否则按 hue 分段；lum<25 前缀「深」、>75 前缀「浅」。 */
export function colorNameZh(hue: number, sat: number, lum: number): string {
  const s = Math.max(0, Math.min(100, sat));
  const l = Math.max(0, Math.min(100, lum));
  if (s < 10) {
    if (l < 20) return "黑";
    if (l < 40) return "深灰";
    if (l < 60) return "灰";
    if (l < 85) return "浅灰";
    return "白";
  }
  const base = hueName(hue);
  const prefix = l < 25 ? "深" : l > 75 ? "浅" : "";
  return prefix + base;
}