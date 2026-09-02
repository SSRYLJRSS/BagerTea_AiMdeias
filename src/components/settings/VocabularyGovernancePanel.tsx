/**
 * F6-d「标签与分类」下的词表治理区块：
 *  - 「新词待确认（N）」：ai_suggestion_items 里 decision='pending' 且 tag_id IS NULL 的候选。
 *    每行三动作：采纳为正式词 / 合并到已有词（补 synonym 别名）/ 拒绝；近似命中显示提示文案。
 *  - 「疑似重复（N 组）」：scan_duplicate_tags 的连通分量结果。每组给「合并到…」下拉。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Button from "@/components/common/Button";
import { aiDecideSuggestionItem, aiListNewWordCandidates } from "@/api/ai";
import {
  mergeTags,
  scanDuplicateTags,
  searchTagCandidates,
  type DuplicateGroup,
  type DuplicateMember,
} from "@/api/tags";
import type { AiSuggestionItem } from "@/types/ai";
import type { Tag } from "@/types/tag";

/** 与 SettingsPage 内 Field 同构的字段容器（避免跨文件耦合 SettingsPage 内部组件） */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 border-b border-[var(--color-border)] py-2">
      <div className="flex items-center justify-between gap-2 px-4">
        <div className="min-w-0">
          <div className="text-sm font-medium text-[var(--color-text)]">{label}</div>
          {hint && (
            <div className="mt-0.5 text-xs text-[var(--color-text-tertiary)]">{hint}</div>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

export default function VocabularyGovernancePanel() {
  const [candidates, setCandidates] = useState<AiSuggestionItem[]>([]);
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // facet → 可选目标标签（供「合并到已有词」）
  const [targetOptions, setTargetOptions] = useState<Record<string, Tag[]>>({});
  // row id → 选中的目标 tag id
  const [mergeTarget, setMergeTarget] = useState<Record<number, number | "">>({});
  // group 合并目标
  const [groupTarget, setGroupTarget] = useState<Record<number, number>>({});

  const loadAll = useCallback(async () => {
    try {
      const [c, g] = await Promise.all([aiListNewWordCandidates(), scanDuplicateTags()]);
      setCandidates(c);
      setGroups(g);
      // 默认每个候选组的主词（首个）为合并目标
      const gmap: Record<number, number> = {};
      for (const grp of g) {
        if (grp.members.length > 0) gmap[grp.members[0].tagId] = grp.members[0].tagId;
      }
      setGroupTarget((prev) => ({ ...prev, ...gmap }));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const needFacet = useMemo(() => {
    const set = new Set<string>();
    for (const c of candidates) if (c.tagId == null) set.add(c.facetKey);
    return set;
  }, [candidates]);

  useEffect(() => {
    const facets = Array.from(needFacet);
    if (facets.length === 0) return;
    for (const f of facets) {
      if (targetOptions[f] !== undefined) continue;
      searchTagCandidates(f, "")
        .then((tags) => {
          setTargetOptions((prev) => ({ ...prev, [f]: tags }));
        })
        .catch(() => {
          setTargetOptions((prev) => ({ ...prev, [f]: [] }));
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needFacet]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      await loadAll();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="py-2">
      <Field label="词表治理" hint="AI 候选词不直接进标签体系：先在这里确认/合并/拒绝（F6）">
        <span />
      </Field>

      {message && (
        <div className="px-4 py-1 text-xs text-[var(--color-danger)]">{message}</div>
      )}

      {/* ── 新词待确认 ── */}
      <Field
        label={`新词待确认（${candidates.length}）`}
        hint="AI 输出的词表外候选：采纳为正式词 / 合并到已有词（自动补同义词）/ 拒绝"
      >
        <Button
          disabled={busy}
          onClick={() => act(async () => {})}
        >
          刷新
        </Button>
      </Field>
      {candidates.length === 0 && (
        <div className="px-4 py-2 text-xs text-[var(--color-text-tertiary)]">
          没有待确认的新词
        </div>
      )}
      {candidates.map((item) => {
        const opts = targetOptions[item.facetKey] ?? [];
        return (
          <div
            key={item.id}
            className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-4 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="text-sm text-[var(--color-text)]">
                「{item.rawName}」
                <span className="ml-2 text-xs text-[var(--color-text-tertiary)]">
                  {item.facetKey}
                  {item.confidence != null ? ` · 置信度 ${Math.round(item.confidence * 100)}%` : ""}
                </span>
              </div>
              {item.decisionReason && (
                <div className="text-xs text-[var(--color-warning)]">{item.decisionReason}，合并？</div>
              )}
            </div>
            <select
              aria-label={`合并目标-${item.rawName}`}
              className="rounded border border-[var(--color-border)] bg-transparent px-1 py-0.5 text-xs"
              value={mergeTarget[item.id] ?? ""}
              disabled={opts.length === 0}
              onChange={(e) =>
                setMergeTarget((prev) => ({
                  ...prev,
                  [item.id]: e.target.value === "" ? "" : Number(e.target.value),
                }))
              }
            >
              <option value="">{opts.length === 0 ? "无同分面标签" : "合并到…"}</option>
              {opts.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <Button
                  disabled={busy}
              onClick={() =>
                act(async () => {
                  await aiDecideSuggestionItem(item.id, "accepted", null, item.rawName);
                })
              }
            >
              采纳为正式词
            </Button>
            <Button
                  disabled={busy || !mergeTarget[item.id]}
              onClick={() =>
                act(async () => {
                  const target = mergeTarget[item.id];
                  if (typeof target === "number") {
                    await aiDecideSuggestionItem(item.id, "modified", target);
                  }
                })
              }
            >
              合并到所选
            </Button>
            <Button
                  disabled={busy}
              onClick={() =>
                act(async () => {
                  await aiDecideSuggestionItem(item.id, "rejected");
                })
              }
            >
              拒绝
            </Button>
          </div>
        );
      })}

      {/* ── 疑似重复 ── */}
      <Field
        label={`疑似重复（${groups.length} 组）`}
        hint="近似匹配的连通分量（仅供人工判断，绝不自动合并）；每组把其余词并入目标词"
      >
        <span />
      </Field>
      {groups.length === 0 && (
        <div className="px-4 py-2 text-xs text-[var(--color-text-tertiary)]">
          未发现疑似重复组
        </div>
      )}
      {groups.map((g, gi) => {
        const target = groupTarget[gi] ?? g.members[0]?.tagId;
        return (
          <div
            key={`${g.facetKey}-${gi}`}
            className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-4 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="text-xs text-[var(--color-text-tertiary)]">{g.facetKey}</div>
              <div className="flex flex-wrap gap-1 text-sm text-[var(--color-text)]">
                {g.members.map((m: DuplicateMember) => (
                  <span
                    key={m.tagId}
                    className={`rounded px-1.5 py-0.5 text-xs ${
                      m.tagId === target
                        ? "bg-[var(--color-accent-muted)] text-[var(--color-accent)]"
                        : "bg-[var(--color-bg-soft)]"
                    }`}
                  >
                    {m.name}
                    {m.assetCount > 0 ? ` (${m.assetCount})` : ""}
                  </span>
                ))}
              </div>
            </div>
            <select
              aria-label={`合并目标组-${gi}`}
              className="rounded border border-[var(--color-border)] bg-transparent px-1 py-0.5 text-xs"
              value={target}
              onChange={(e) =>
                setGroupTarget((prev) => ({ ...prev, [gi]: Number(e.target.value) }))
              }
            >
              {g.members.map((m) => (
                <option key={m.tagId} value={m.tagId}>
                  {m.name}
                </option>
              ))}
            </select>
            <Button
                  disabled={busy}
              onClick={() =>
                act(async () => {
                  for (const m of g.members) {
                    if (m.tagId !== target) {
                      await mergeTags(m.tagId, target);
                    }
                  }
                })
              }
            >
              合并到所选
            </Button>
          </div>
        );
      })}
    </div>
  );
}
