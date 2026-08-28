/**
 * FB2-08（§14.10/14.11）：色条组件。紧贴媒体下沿的无缝色带，段宽按占比（或等宽），
 * 只有主色段可点击（§14.9 方案 A）。palette 为空/未计算 → 不渲染（增强信息缺失时安静消失）。
 */
import { colorNameZh } from "@/utils/colorName";
import type { PaletteSegmentDto } from "@/types/asset";

export interface PaletteSegment {
  hex: string;
  ratio: number;
  hue: number;
  sat: number;
  lum: number;
}

/** 由后端色板 DTO（hex/r/g/b/ratio）转组件分段；hue/sat/lum 现场从 RGB 推。 */
export function toPaletteSegments(dto: PaletteSegmentDto[] | null | undefined): PaletteSegment[] {
  if (!dto || !dto.length) return [];
  return dto.map((d) => {
    const hsv = rgbToHsv(d.r, d.g, d.b);
    return {
      hex: d.hex || `#${[d.r, d.g, d.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`,
      ratio: d.ratio,
      hue: hsv[0],
      sat: hsv[1],
      lum: hsv[2],
    };
  });
}

/** RGB(0-255) → [hue(0-360), sat(0-100), value(0-100)] */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = 60 * (((gn - bn) / d) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / d + 2);
    else h = 60 * ((rn - gn) / d + 4);
  }
  if (h < 0) h += 360;
  const s = max === 0 ? 0 : (d / max) * 100;
  const v = max * 100;
  return [Math.round(h), Math.round(s), Math.round(v)];
}

export type ColorStripHeight = "thin" | "normal" | "thick";
export type ColorStripMode = "ratio" | "equal";

const HEIGHT_PX: Record<ColorStripHeight, number> = { thin: 6, normal: 10, thick: 16 };

export default function ColorStrip({
  palette,
  mode = "ratio",
  height = "normal",
  rounded = false,
  onSearchDominant,
}: {
  palette: PaletteSegment[];
  mode?: ColorStripMode;
  height?: ColorStripHeight;
  /** 底边圆角（网格卡片里用；Viewer 无圆角） */
  rounded?: boolean;
  /** 点击主色段回调（以该色搜索）；不传则主色段也不可点 */
  onSearchDominant?: (segment: PaletteSegment) => void;
}) {
  if (!palette.length) return null; // 空态：不占位
  const segments = palette.slice(0, 8);
  const total = segments.reduce((a, s) => a + Math.max(0, s.ratio), 0) || segments.length;
  const label = `主色：${segments
    .map((s) => `${colorNameZh(s.hue, s.sat, s.lum)} ${Math.round(s.ratio * 100)}%`)
    .join("、")}`;
  const h = HEIGHT_PX[height];

  return (
    <div
      className="ui-colorstrip"
      style={{ height: h, borderRadius: rounded ? "0 0 4px 4px" : undefined }}
      role="img"
      aria-label={label}
    >
      {segments.map((s, i) => {
        const width =
          mode === "ratio" ? `${(Math.max(0, s.ratio) / total) * 100}%` : `${100 / segments.length}%`;
        const isDominant = i === 0;
        return (
          <div
            key={i}
            title={`${s.hex} · ${Math.round(s.ratio * 100)}%`}
            style={{
              width,
              background: s.hex,
              height: "100%",
              cursor: isDominant && onSearchDominant ? "pointer" : "default",
            }}
            onClick={
              isDominant && onSearchDominant ? () => onSearchDominant(s) : undefined
            }
          />
        );
      })}
    </div>
  );
}