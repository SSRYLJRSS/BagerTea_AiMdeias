/** 胶片条（PRD 5.3 v2.5）：本次带入素材横排缩略图
 *  - 状态角标：待打标(灰) / 已建议(主题色) / 已确认(黑) / 已拒绝(暗)
 *  - 点击切当前张；Ctrl+点击 多选（批量套用用）
 */
import clsx from "clsx";
import { useEffect, useState } from "react";
import { getThumbnailUrl, toFileUrl } from "@/api/thumbnail";
import type { AiSuggestion } from "@/types/ai";

interface FilmstripProps {
  suggestions: AiSuggestion[];
  currentId: number | null;
  selectedIds: Set<number>;
  onPick: (s: AiSuggestion, ctrl: boolean) => void;
}

/** 单个缩略图：占位图 → 原图回退链 */
function Thumb({ s, active, selected, onPick }: { s: AiSuggestion; active: boolean; selected: boolean; onPick: (ctrl: boolean) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getThumbnailUrl(s.assetId, "placeholder")
      .then((u) => !cancelled && setUrl(u))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [s.assetId]);

  const dot =
    s.status === "confirmed"
      ? "bg-[var(--color-text)]"
      : s.status === "rejected"
        ? "bg-[var(--color-border)]"
        : Object.keys(s.suggestedTags).length > 0
          ? "bg-[var(--color-accent)]"
          : "bg-[var(--color-text-secondary)] opacity-40";

  return (
    <button
      onClick={(e) => onPick(e.ctrlKey || e.metaKey)}
      className={clsx(
        "relative h-14 w-14 shrink-0 overflow-hidden rounded border-2 transition-all",
        active ? "border-[var(--color-accent)]" : selected ? "border-[var(--color-text-secondary)]" : "border-transparent opacity-80 hover:opacity-100",
      )}
      title={s.assetPath.split(/[\\/]/).pop()}
    >
      {url && !failed ? (
        <img
          src={url}
          alt=""
          className="h-full w-full object-cover"
          onError={() => {
            // 占位图不存在时直接退原图
            if (url !== toFileUrl(s.assetPath)) setUrl(toFileUrl(s.assetPath));
            else setFailed(true);
          }}
        />
      ) : (
        <div className="h-full w-full bg-[var(--color-surface)]" />
      )}
      <span className={clsx("absolute right-0.5 bottom-0.5 h-2 w-2 rounded-full", dot)} />
    </button>
  );
}

export default function Filmstrip({ suggestions, currentId, selectedIds, onPick }: FilmstripProps) {
  if (suggestions.length === 0) return null;
  return (
    <div className="flex shrink-0 gap-1.5 overflow-x-auto border-t border-[var(--color-border)] px-3 py-2">
      {suggestions.map((s) => (
        <Thumb
          key={s.id}
          s={s}
          active={s.id === currentId}
          selected={selectedIds.has(s.assetId)}
          onPick={(ctrl) => onPick(s, ctrl)}
        />
      ))}
    </div>
  );
}
