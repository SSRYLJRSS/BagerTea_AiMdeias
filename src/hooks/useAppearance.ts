/**
 * useAppearance（FB2-01/02/03/08）：读取当前生效的外观设置（素材网格档位/比例/填充、悬停预览、色条）。
 * 从 settingsStore 取已归一化 settings，未就绪时回落 DEFAULT_APPEARANCE，保证渲染不崩溃。
 */
import { useShallow } from "zustand/react/shallow";
import { useSettingsStore, currentAppearance } from "@/stores/settingsStore";
import type { Appearance, CellAspect } from "@/types/settings";

export function useAppearance(): Appearance {
  const settings = useSettingsStore(
    useShallow((s) => s.settings),
  );
  const preview = useSettingsStore(
    useShallow((s) => s.previewAppearance),
  );
  return currentAppearance(settings, preview);
}

/** 维度解析：把 "4:3" 之类解析成 w/h 比（用于占位容器比例计算）。非法值回退 1。 */
export function parseAspect(aspect: CellAspect): { w: number; h: number } {
  const [w, h] = aspect.split(":").map((n) => Number(n));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return { w: 1, h: 1 };
  return { w, h };
}

/** 按 aspect 计算容器的 paddingTop 百分比（aspect-ratio 的兜底，供不支持的场景）。 */
export function aspectPaddingTop(aspect: CellAspect): number {
  const { w, h } = parseAspect(aspect);
  return (h / w) * 100;
}