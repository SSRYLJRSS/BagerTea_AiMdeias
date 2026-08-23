/** AI 打标页（PRD v2.5 工作台 2.0）：左数据栏 + 右侧四段式（大图/EXIF 行/胶片条/分类标签面板） */
import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { useShallow } from "zustand/react/shallow";
import Button from "@/components/common/Button";
import ModelSelect from "@/components/common/ModelSelect";
import ProgressBar from "@/components/common/ProgressBar";
import Filmstrip from "@/components/ai/Filmstrip";
import Workbench from "@/components/ai/Workbench";
import { aiApplyTags, onAiProgress } from "@/api/ai";
import { recentTagOps, undoTagBatch } from "@/api/tags";
import { useTauriEvent } from "@/hooks/hooks";
import { useAiStore } from "@/stores/aiStore";
import { useLibraryStore } from "@/stores/libraryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTagStore } from "@/stores/tagStore";
import type { AiSuggestion, CategorizedTags } from "@/types/ai";
import type { TagOp } from "@/types/asset";

export default function AiTaggingPage() {
  const {
    batches, currentBatchId, suggestions, running, cancelling, error, pendingAssetIds, pendingMode,
  } = useAiStore(
    useShallow((s) => ({
      batches: s.batches,
      currentBatchId: s.currentBatchId,
      suggestions: s.suggestions,
      running: s.running,
      cancelling: s.cancelling,
      error: s.error,
      pendingAssetIds: s.pendingAssetIds,
      pendingMode: s.pendingMode,
    })),
  );
  const {
    refreshBatches, openBatch, createBatch, startBatch, cancel, confirm, reject, restore, confirmAll, patchProgress,
  } = useAiStore(
    useShallow((s) => ({
      refreshBatches: s.refreshBatches,
      openBatch: s.openBatch,
      createBatch: s.createBatch,
      startBatch: s.startBatch,
      cancel: s.cancel,
      confirm: s.confirm,
      reject: s.reject,
      restore: s.restore,
      confirmAll: s.confirmAll,
      patchProgress: s.patchProgress,
    })),
  );
  const refreshLibrary = useLibraryStore((s) => s.refresh);
  const refreshTags = useTagStore((s) => s.refresh);
  const { settings, loaded, load, save } = useSettingsStore(
    useShallow((s) => ({ settings: s.settings, loaded: s.loaded, load: s.load, save: s.save })),
  );

  // 打标模式（v2.10 / P3-01a）：AI 打标（云端/本地按激活档案自动解析）/ 手动
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  // 打标范围（v2.11）：全部 / 仅前 N 张
  const [scopeAll, setScopeAll] = useState(true);
  const [scopeN, setScopeN] = useState("10");

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  // 素材库选好跳过来 → 只自动建批次展示图片，AI 由左栏「开始打标」手动启动（v2.10 修订）
  useEffect(() => {
    if (pendingAssetIds.length > 0 && !running) void createBatch(pendingMode);
  }, [pendingAssetIds, running, pendingMode, createBatch]);

  const activeProfile =
    settings?.ai.profiles.find((p) => p.id === settings.ai.activeProfile) ?? settings?.ai.profiles[0] ?? null;

  // 打标页切换档案/模型即保存生效（PRD 5.3：中转站快速切换）
  // P2-10：保存失败不再被 void 吞掉——显示错误，避免 UI 已切换而后端仍用旧配置
  const [saveError, setSaveError] = useState<string | null>(null);
  const switchProfile = useCallback(
    async (id: string) => {
      if (!settings) return;
      try {
        await save({ ...settings, ai: { ...settings.ai, activeProfile: id } });
        setSaveError(null);
      } catch (e) {
        setSaveError(e instanceof Error ? e.message : String(e));
      }
    },
    [settings, save],
  );
  const changeModel = useCallback(
    async (v: string) => {
      if (settings && activeProfile) {
        try {
          await save({
            ...settings,
            ai: { ...settings.ai, profiles: settings.ai.profiles.map((p) => (p.id === activeProfile.id ? { ...p, model: v } : p)) },
          });
          setSaveError(null);
        } catch (e) {
          setSaveError(e instanceof Error ? e.message : String(e));
        }
      }
    },
    [settings, activeProfile, save],
  );

  const [reviewIdx, setReviewIdx] = useState(0);

  useEffect(() => {
    void refreshBatches();
  }, [refreshBatches]);

  useTauriEvent(() => onAiProgress((p) => patchProgress(p.processed)), []);

  const current = batches.find((b) => b.id === currentBatchId) ?? null;
  /** 当前批次是否走 AI 管线（云端或本地，P3-01a：开始打标按钮对两者常显） */
  const isAiBatch = current?.mode === "cloud" || current?.mode === "local";
  const aiLabel = current?.mode === "local" ? "本地" : "云端";
  const pending = useMemo(() => suggestions.filter((s) => s.status === "pending"), [suggestions]);
  const stats = useMemo(
    () => ({
      pending: pending.length,
      confirmed: suggestions.filter((s) => s.status === "confirmed").length,
      rejected: suggestions.filter((s) => s.status === "rejected").length,
    }),
    [suggestions, pending],
  );

  // 过片走全量建议（胶片条含已确认/已拒绝，状态角标区分）
  const idx = Math.min(reviewIdx, Math.max(0, suggestions.length - 1));
  const currentSuggestion: AiSuggestion | null = suggestions[idx] ?? null;

  const goto = useCallback(
    (next: number) => setReviewIdx(Math.max(0, Math.min(next, suggestions.length - 1))),
    [suggestions.length],
  );

  // 当前张编辑中的标签（切张即重置：已确认张展示 confirmed，其余展示 suggested）
  const [draftTags, setDraftTags] = useState<CategorizedTags>({});
  useEffect(() => {
    if (!currentSuggestion) return;
    const src =
      currentSuggestion.status === "confirmed" && Object.keys(currentSuggestion.confirmedTags).length > 0
        ? currentSuggestion.confirmedTags
        : currentSuggestion.suggestedTags;
    setDraftTags(structuredClone(src));
    // 依赖含 suggestedTags 内容：批次跑完回载后 id/status 不变但标签已写入，
    // 若只依赖 [id, status] 当前张会停在旧的空 draft，此时点确认会写入空标签
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSuggestion?.id, currentSuggestion?.status, JSON.stringify(currentSuggestion?.suggestedTags)]);

  // 胶片条多选（批量套用用，按 assetId）
  const [selectedAssets, setSelectedAssets] = useState<Set<number>>(new Set());
  const onFilmPick = useCallback(
    (s: AiSuggestion, ctrl: boolean) => {
      if (ctrl) {
        setSelectedAssets((prev) => {
          const next = new Set(prev);
          if (next.has(s.assetId)) next.delete(s.assetId);
          else next.add(s.assetId);
          return next;
        });
      } else {
        const i = suggestions.findIndex((x) => x.id === s.id);
        if (i >= 0) setReviewIdx(i);
      }
    },
    [suggestions],
  );

  const onConfirmAll = async () => {
    await confirmAll();
    await Promise.all([refreshLibrary(), refreshTags()]);
  };

  const afterWrite = async () => {
    await Promise.all([refreshLibrary(), refreshTags()]);
    void loadRecent(); // R-25：确认后刷新最近打标流水
  };

  // R-25 最近打标流水 + 批次撤销（两击确认防误触）
  const [recentOps, setRecentOps] = useState<TagOp[]>([]);
  const [undoArmed, setUndoArmed] = useState<number | null>(null);
  const loadRecent = useCallback(async () => {
    try {
      setRecentOps(await recentTagOps(50));
    } catch {
      /* 流水拉取失败不阻塞主流程 */
    }
  }, []);
  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);
  const undoBatch = async (batchId: number) => {
    if (undoArmed !== batchId) {
      setUndoArmed(batchId);
      return;
    }
    setUndoArmed(null);
    await undoTagBatch(batchId);
    await Promise.all([refreshLibrary(), refreshTags()]);
    await loadRecent();
  };

  // 批量套用：把当前张标签写到胶片条选中素材（连拍/同场景提速）
  const [applying, setApplying] = useState(false);
  const applyToSelected = async () => {
    if (selectedAssets.size === 0 || Object.keys(draftTags).length === 0) return;
    setApplying(true);
    try {
      await aiApplyTags(Array.from(selectedAssets), draftTags);
      setSelectedAssets(new Set());
      await afterWrite();
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="flex h-full">
      {/* 左侧数据栏 */}
      <aside className="flex w-[180px] shrink-0 flex-col border-r border-[var(--color-border)]">
        <div className="border-b border-[var(--color-border)] p-3">
          <h3 className="mb-2 text-xs font-medium tracking-wide text-[var(--color-text-secondary)] uppercase">
            打标模式
          </h3>
          <div className="flex flex-col gap-1 text-sm">
            {(
              [
                ["auto", "AI 打标"],
                ["manual", "手动模式"],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={clsx(
                  "rounded px-2 py-1 text-left transition-colors",
                  mode === m
                    ? "bg-[var(--color-surface)] text-[var(--color-text)]"
                    : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]",
                )}
              >
                {label}
              </button>
            ))}
            {mode === "auto" && (
              <span className="rounded px-2 text-[10px] leading-4 text-[var(--color-text-secondary)]">
                {activeProfile?.kind === "local"
                  ? `当前走本地服务（${activeProfile.name || "未命名"}）`
                  : "当前走云端 API；本地打标请到「设置 → 本地打标」配置本地模型并选中使用"}
              </span>
            )}
          </div>
          {/* AI 批次启动区：不在运行中就常显「开始打标」（打完也保留，可续跑剩余 pending；v2.12） */}
          {isAiBatch && !running && (
            <div className="mt-3 flex flex-col gap-1.5">
              <label className="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)]">
                <input type="radio" checked={scopeAll} onChange={() => setScopeAll(true)} />
                打标全部（{current.total} 张）
              </label>
              <label className="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)]">
                <input type="radio" checked={!scopeAll} onChange={() => setScopeAll(false)} />
                仅打标前
                <input
                  value={scopeN}
                  onChange={(e) => {
                    setScopeN(e.target.value.replace(/\D/g, ""));
                    setScopeAll(false);
                  }}
                  onFocus={() => setScopeAll(false)}
                  inputMode="numeric"
                  className="w-12 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 text-center text-xs outline-none focus:border-[var(--color-accent)]"
                />
                张
              </label>
              <Button
                variant="primary"
                className="mt-1 w-full"
                disabled={!scopeAll && (!scopeN || parseInt(scopeN, 10) < 1)}
                onClick={() => void startBatch(scopeAll ? undefined : parseInt(scopeN, 10))}
              >
                开始打标
              </Button>
            </div>
          )}
          {running && (
            <Button
              className="mt-3 w-full"
              disabled={cancelling}
              onClick={() => void cancel()}
            >
              {cancelling ? "已请求取消…" : "取消"}
            </Button>
          )}
          <p className="mt-2 text-[10px] leading-4 text-[var(--color-text-secondary)]">
            {running
              ? cancelling
                ? "取消已受理，当前图片完成后停止" // P2-01：300s 单请求超时不可打断，诚实告知
                : `${aiLabel}打标中…`
              : isAiBatch
                ? current?.status === "pending"
                  ? `批次已就绪，图片已载入——点「开始打标」启动${aiLabel}打标`
                  : "点「开始打标」可继续处理剩余未打标项"
                : "在素材库选中素材后，顶栏「打标 → AI/手动」直达本页"}
          </p>
        </div>

        {settings && mode === "auto" && (
          <div className="border-b border-[var(--color-border)] p-3">
            <h3 className="mb-2 text-xs font-medium tracking-wide text-[var(--color-text-secondary)] uppercase">
              API 配置 / 模型
            </h3>
            {settings.ai.profiles.length === 0 ? (
              <p className="text-xs leading-5 text-[var(--color-text-secondary)]">
                还没有 API 配置，去「设置 → AI 打标」添加中转站或本地服务
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                <select
                  value={activeProfile?.id ?? ""}
                  onChange={(e) => switchProfile(e.target.value)}
                  className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text)] outline-none"
                >
                  {settings.ai.profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name || "未命名"}
                    </option>
                  ))}
                </select>
                {activeProfile && (
                  <ModelSelect
                    apiMode={activeProfile.apiMode}
                    baseUrl={activeProfile.baseUrl}
                    apiKey={activeProfile.apiKey}
                    value={activeProfile.model}
                    onChange={changeModel}
                  />
                )}
              </div>
            )}
          </div>
        )}

        {current && (
          <div className="border-b border-[var(--color-border)] p-3">
            <h3 className="mb-2 text-xs font-medium tracking-wide text-[var(--color-text-secondary)] uppercase">
              批次 #{current.id}
            </h3>
            <div className="flex flex-col gap-1 text-sm text-[var(--color-text)]">
              <span>待确认 {stats.pending}</span>
              <span>已确认 {stats.confirmed}</span>
              <span>已拒绝 {stats.rejected}</span>
              <span className="text-xs text-[var(--color-text-secondary)]">共 {suggestions.length} 张</span>
            </div>
            {running && (
              <div className="mt-2">
                <ProgressBar value={current.total ? current.processed / current.total : 0} />
                <p className="mt-1 text-[10px] text-[var(--color-text-secondary)]">
                  {current.mode === "manual" ? "手动模式：请逐张编辑标签" : `${aiLabel}生成建议 ${current.processed}/${current.total}`}
                </p>
              </div>
            )}
            {stats.pending > 0 && !running && (
              <Button className="mt-2 w-full" variant="primary" onClick={() => void onConfirmAll()}>
                全部确认（{stats.pending}）
              </Button>
            )}
          </div>
        )}

        {(batches.length > 0 || recentOps.length > 0) && (
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {batches.length > 0 && (
              <>
                <h3 className="mb-1 px-1 text-xs font-medium tracking-wide text-[var(--color-text-secondary)] uppercase">
                  历史批次
                </h3>
                {batches.map((b) => (
                  <div key={b.id} className="flex items-center gap-1">
                    <button
                      onClick={() => {
                        setReviewIdx(0);
                        void openBatch(b.id);
                      }}
                      className={clsx(
                        "min-w-0 flex-1 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--color-surface)]",
                        b.id === currentBatchId
                          ? "bg-[var(--color-surface)] text-[var(--color-text)]"
                          : "text-[var(--color-text-secondary)]",
                      )}
                    >
                      #{b.id} · {b.mode === "cloud" ? "云端" : b.mode === "manual" ? "手动" : "本地"} · {b.confirmed}/{b.total}
                      <span className="block opacity-60">{new Date(b.createdAt).toLocaleDateString()}</span>
                    </button>
                    {/* R-25：AI 批次撤销（两击确认） */}
                    {b.mode !== "manual" && b.confirmed > 0 && (
                      <button
                        onClick={() => void undoBatch(b.id)}
                        title="撤销本批次已确认的标签（再点一次确认）"
                        className={clsx(
                          "shrink-0 rounded px-1.5 py-1 text-[10px] transition-colors",
                          undoArmed === b.id
                            ? "bg-[var(--color-danger)] text-white"
                            : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)] hover:text-[var(--color-danger)]",
                        )}
                      >
                        {undoArmed === b.id ? "确认?" : "撤销"}
                      </button>
                    )}
                  </div>
                ))}
              </>
            )}

            {/* R-25 最近打标：挂/摘流水，AI 来源带角标 */}
            {recentOps.length > 0 && (
              <>
                <h3 className="mt-3 mb-1 px-1 text-xs font-medium tracking-wide text-[var(--color-text-secondary)] uppercase">
                  最近打标
                </h3>
                {recentOps.map((o) => (
                  <div key={o.id} className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-[var(--color-text-secondary)]">
                    <span className={o.op === "add" ? "text-[var(--color-text)]" : "text-[var(--color-danger)]"}>
                      {o.op === "add" ? "＋" : "－"}
                    </span>
                    <span className="shrink-0 text-[var(--color-text)]">{o.tagName}</span>
                    <span className="min-w-0 flex-1 truncate opacity-70" title={o.assetName}>{o.assetName}</span>
                    {o.actor !== "manual" && (
                      <span className="shrink-0 rounded bg-[var(--color-surface)] px-1 text-[9px]">AI</span>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </aside>

      {/* 右侧四段式：大图 → EXIF 行（在 Workbench 内）→ 胶片条 → 分类标签面板 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {error && <p className="px-4 pt-2 text-xs text-[var(--color-danger)]">{error}</p>}
        {saveError && <p className="px-4 pt-2 text-xs text-[var(--color-danger)]">配置保存失败：{saveError}</p>}

        {currentSuggestion ? (
          <>
            <Workbench
              suggestion={currentSuggestion}
              categories={settings?.tagCategories ?? []}
              tags={draftTags}
              onTagsChange={setDraftTags}
              index={idx}
              total={suggestions.length}
              onGoto={goto}
              onConfirm={async () => {
                await confirm(currentSuggestion.id, draftTags);
                await afterWrite();
              }}
              onReject={async () => {
                await reject(currentSuggestion.id);
              }}
              onRestore={async () => {
                await restore(currentSuggestion.id);
              }}
            />

            {/* 胶片条 + 批量套用 */}
            <div className="relative shrink-0">
              <Filmstrip
                suggestions={suggestions}
                currentId={currentSuggestion.id}
                selectedIds={selectedAssets}
                onPick={onFilmPick}
              />
              {selectedAssets.size > 0 && (
                <div className="absolute right-3 -top-9 flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 shadow">
                  <span className="text-xs text-[var(--color-text-secondary)]">已选 {selectedAssets.size} 张</span>
                  <button
                    onClick={() => void applyToSelected()}
                    disabled={applying || Object.keys(draftTags).length === 0}
                    className="rounded bg-[var(--color-accent)] px-2 py-0.5 text-xs text-[var(--color-accent-text)] disabled:opacity-50"
                  >
                    {applying ? "套用中…" : "套用当前标签"}
                  </button>
                  <button
                    onClick={() => setSelectedAssets(new Set())}
                    className="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
                  >
                    取消
                  </button>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-[var(--color-text-secondary)]">
            {running
              ? `${aiLabel}正在生成标签建议…`
              : suggestions.length > 0
                ? "本批次已全部处理完毕"
                : "还没有打标批次——去素材库选中素材，点顶部「AI 打标」"}
          </div>
        )}
      </div>
    </div>
  );
}

