/** 打标工作台（PRD v2.11）：大图（底部居中悬浮导航条）+ EXIF 行 + 两列分类标签面板
 *  导航：←/→ 键、悬浮条按钮、跳转到第 N 张
 *  按钮规范：主 CTA 黑色实心（确认写入），其余幽灵文字按钮
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Button from "@/components/common/Button";
import TagChip from "@/components/library/TagChip";
import { getAsset } from "@/api/assets";
import { getThumbnailUrl, toFileUrl } from "@/api/thumbnail";
import type { AiSuggestion, CategorizedTags } from "@/types/ai";
import type { Asset } from "@/types/asset";
import type { TagCategory } from "@/types/settings";

type ImgStage = "hd" | "ph" | "orig";

interface WorkbenchProps {
  suggestion: AiSuggestion;
  categories: TagCategory[];
  tags: CategorizedTags;
  onTagsChange: (t: CategorizedTags) => void;
  index: number; // 0 基
  total: number;
  onGoto: (i: number) => void;
  onConfirm: () => Promise<void>;
  onReject: () => Promise<void>;
  onRestore: () => Promise<void>;
}

function exifLine(a: Asset | null): string {
  if (!a) return "";
  const parts: string[] = [];
  if (a.camera) parts.push(a.camera);
  if (a.lens) parts.push(a.lens);
  if (a.aperture != null) parts.push(`f/${a.aperture}`);
  if (a.shutter) parts.push(`${a.shutter}s`);
  if (a.iso != null) parts.push(`ISO${a.iso}`);
  if (a.focal != null) parts.push(`${a.focal}mm`);
  if (a.takenAt != null) parts.push(new Date(a.takenAt).toLocaleString("zh-CN", { hour12: false }));
  return parts.join(" · ");
}

export default function Workbench({
  suggestion: s,
  categories,
  tags,
  onTagsChange,
  index,
  total,
  onGoto,
  onConfirm,
  onReject,
  onRestore,
}: WorkbenchProps) {
  const [stage, setStage] = useState<ImgStage>("hd");
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [asset, setAsset] = useState<Asset | null>(null);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [jump, setJump] = useState("");

  const isRejected = s.status === "rejected";
  const readOnly = s.status === "confirmed" || isRejected;

  // 大图：高清优先；img onError 逐层降级
  useEffect(() => {
    let cancelled = false;
    setStage("hd");
    setImgUrl(null);
    getThumbnailUrl(s.assetId, "hd", 1280)
      .then((u) => !cancelled && setImgUrl(u))
      .catch(() => !cancelled && setStage("orig"));
    return () => {
      cancelled = true;
    };
  }, [s.assetId]);

  const onImgError = () => {
    if (stage === "hd") {
      setStage("ph");
      getThumbnailUrl(s.assetId, "placeholder")
        .then(setImgUrl)
        .catch(() => setStage("orig"));
    } else {
      setStage("orig");
      setImgUrl(toFileUrl(s.assetPath));
    }
  };
  useEffect(() => {
    if (stage === "orig") setImgUrl(toFileUrl(s.assetPath));
  }, [stage, s.assetPath]);

  // EXIF 元信息（只读参考行）
  useEffect(() => {
    let cancelled = false;
    getAsset(s.assetId)
      .then((a) => !cancelled && setAsset(a))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [s.assetId]);

  // 面板分类 = 设置分类 ∪ 标签里已出现的分类
  const panelCategories = useMemo(() => {
    const names = categories.map((c) => c.name);
    const extra = Object.keys(tags).filter((k) => !names.includes(k));
    return [...categories, ...extra.map((name) => ({ name, hint: "", single: false, max: 3 }))];
  }, [categories, tags]);

  const setCategoryTags = (name: string, list: string[]) => {
    const next = { ...tags };
    if (list.length === 0) delete next[name];
    else next[name] = list;
    onTagsChange(next);
  };

  const addTag = (c: TagCategory) => {
    const t = (editing[c.name] ?? "").trim();
    if (!t) return;
    const cur = tags[c.name] ?? [];
    if (cur.includes(t)) {
      setEditing({ ...editing, [c.name]: "" });
      return;
    }
    // 数量上限：单选恒 1，否则 c.max（v2.11）
    const cap = c.single ? 1 : Math.max(1, c.max || 3);
    if (cur.length >= cap && !c.single) return;
    setCategoryTags(c.name, c.single ? [t] : [...cur, t]);
    setEditing({ ...editing, [c.name]: "" });
  };

  const totalTags = Object.values(tags).reduce((n, l) => n + l.length, 0);
  const fileName = s.assetPath.split(/[\\/]/).pop() ?? s.assetPath;
  const exif = exifLine(asset);

  const handleConfirm = useCallback(async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  }, [onConfirm]);

  const doJump = () => {
    const n = parseInt(jump, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= total) onGoto(n - 1);
    setJump("");
  };

  // 快捷键：←/→ 过片，Enter 确认
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "ArrowLeft") onGoto(index - 1);
      else if (e.key === "ArrowRight") onGoto(index + 1);
      else if (e.key === "Enter") void handleConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, onGoto, handleConfirm]); // B33：补依赖数组，避免每次渲染重绑

  return (
    <>
      {/* ① 大图区 + 底部居中悬浮导航条 */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[var(--color-surface)] p-4">
        {imgUrl ? (
          <img src={imgUrl} alt={fileName} onError={onImgError} className="max-h-full max-w-full rounded object-contain" />
        ) : (
          <div className="h-32 w-32 animate-pulse rounded bg-[var(--color-border)]" />
        )}
        <span className="absolute top-2 right-3 rounded bg-black/50 px-2 py-0.5 text-xs text-white">
          {index + 1} / {total}
        </span>
        <span className="absolute top-2 left-3 max-w-[60%] truncate rounded bg-black/50 px-2 py-0.5 text-xs text-white">
          {fileName}
        </span>

        {/* 悬浮导航条（v2.11）：← 位置/跳转 → */}
        <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-bg)]/90 px-1.5 py-1 shadow-lg backdrop-blur">
          <button
            onClick={() => onGoto(index - 1)}
            disabled={index <= 0}
            title="上一张（←）"
            className="flex h-6 w-7 items-center justify-center rounded-full text-sm text-[var(--color-text)] transition-colors hover:bg-[var(--color-surface)] disabled:opacity-30"
          >
            ←
          </button>
          <span className="px-1 text-xs text-[var(--color-text-secondary)]">
            {index + 1} / {total}
          </span>
          <button
            onClick={() => onGoto(index + 1)}
            disabled={index >= total - 1}
            title="下一张（→）"
            className="flex h-6 w-7 items-center justify-center rounded-full text-sm text-[var(--color-text)] transition-colors hover:bg-[var(--color-surface)] disabled:opacity-30"
          >
            →
          </button>
          <span className="mx-0.5 h-4 w-px bg-[var(--color-border)]" />
          <input
            value={jump}
            onChange={(e) => setJump(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && doJump()}
            placeholder="跳至"
            title="跳转到第 N 张，Enter 确认"
            className="w-10 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-center text-xs outline-none focus:border-[var(--color-accent)]"
          />
        </div>
      </div>

      {/* ② EXIF 只读参考行 */}
      {exif && (
        <div className="shrink-0 border-t border-[var(--color-border)] px-3 py-1 text-[11px] text-[var(--color-text-secondary)]">
          {exif}
        </div>
      )}

      {/* ③ 分类标签面板：一排两个分类（v2.11） */}
      <div className="max-h-52 shrink-0 overflow-y-auto border-t border-[var(--color-border)] p-3">
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          {panelCategories.map((c) => {
            const list = tags[c.name] ?? [];
            return (
              <div key={c.name} className="flex items-start gap-2">
                <span className="mt-1 w-14 shrink-0 truncate text-xs font-medium text-[var(--color-text-secondary)]" title={c.name}>
                  {c.name}
                </span>
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                  {list.map((t) => (
                    <TagChip key={t} label={t} onRemove={readOnly ? undefined : () => setCategoryTags(c.name, list.filter((x) => x !== t))} />
                  ))}
                  {!readOnly && (
                    <input
                      value={editing[c.name] ?? ""}
                      onChange={(e) => setEditing({ ...editing, [c.name]: e.target.value })}
                      onKeyDown={(e) => e.key === "Enter" && addTag(c)}
                      placeholder="+ 加标签"
                      className="w-16 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-xs outline-none focus:border-[var(--color-accent)]"
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <span className="text-xs text-[var(--color-text-secondary)]">共 {totalTags} 个标签</span>
          <div className="ml-auto flex gap-2">
            {isRejected ? (
              <Button onClick={() => void onRestore()}>恢复（撤销拒绝）</Button>
            ) : s.status === "confirmed" ? (
              <span className="rounded bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)]">
                本张已确认
              </span>
            ) : (
              <>
                <Button disabled={busy} onClick={() => void onReject()}>
                  拒绝
                </Button>
                <Button variant="primary" disabled={busy || totalTags === 0} onClick={() => void handleConfirm()}>
                  {busy ? "写入中…" : "确认写入（Enter）"}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
