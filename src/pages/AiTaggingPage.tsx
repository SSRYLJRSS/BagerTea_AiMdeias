/** AI 打标页（PRD v2.5 工作台 2.0）：左数据栏 + 右侧四段式（大图/EXIF 行/胶片条/分类标签面板）
 *  FB6 需求一：页内进度唯一化——「当前批次」区块的 AiTaggingProgress 是唯一 AI 进度 UI；
 *  全局任务条中的「AI 打标中」胶囊已从 taskStore 移除（taskStore 只订阅入库/导出）。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { useShallow } from "zustand/react/shallow";
import Button from "@/components/common/Button";
import LegacyProfileModelField from "@/components/common/LegacyProfileModelField";
import AiTaggingProgress, { assetFileLabel } from "@/components/ai/AiTaggingProgress";
import Filmstrip from "@/components/ai/Filmstrip";
import Workbench from "@/components/ai/Workbench";
import { aiApplyTags, onAiProgress } from "@/api/ai";
import { recentTagOps, undoTagBatch } from "@/api/tags";
import { useTauriEvent } from "@/hooks/hooks";
import { useAiStore } from "@/stores/aiStore";
import { useLibraryStore } from "@/stores/libraryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTagStore, buildWorkbenchFacets, normalizeTagKeys } from "@/stores/tagStore";
import { computeAiStats, estimateRequests } from "@/utils/aiStats";
import { pickReviewDescription } from "@/utils/reviewDescription";
import type { AiSuggestion, AiTaggingUiState, CategorizedTags } from "@/types/ai";
import type { TagOp } from "@/types/asset";

export default function AiTaggingPage() {
  const {
    batches, currentBatchId, suggestions, running, cancelling, error, pendingAssetIds, pendingMode, lastProgressAssetId,
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
      lastProgressAssetId: s.lastProgressAssetId,
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
  const tagFacets = useTagStore((s) => s.facets);
  const refreshTags = useTagStore((s) => s.refresh);
  const { settings, loaded, load, save } = useSettingsStore(
    useShallow((s) => ({ settings: s.settings, loaded: s.loaded, load: s.load, save: s.save })),
  );

  // 阶段 6 §9.2/§9.3：工作台分面 = tag_facets（唯一事实源）+ aiFacetConfigs 覆盖；系统分面恒显
  // W3-2：分面语义全部来自 tag_facets（inputMode 分组），不再读 settings.aiFacetConfigs
  const workbenchFacets = useMemo(
    () => buildWorkbenchFacets(tagFacets),
    [tagFacets],
  );
  useEffect(() => {
    if (tagFacets.length === 0) void refreshTags();
  }, [tagFacets.length, refreshTags]);

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

  // FB6 需求一：进度事件唯一订阅入口（页面内），同时更新 aiStore 与「已收到进度」标记。
  // startBatch 即置 running（starting 相位立即有视觉反馈），首条事件到达后进入 running 相位。
  const [sawProgress, setSawProgress] = useState(false);
  useTauriEvent(
    () =>
      onAiProgress((p) => {
        patchProgress(p.processed, p.currentAssetId);
        setSawProgress(true);
      }),
    [],
  );

  const current = batches.find((b) => b.id === currentBatchId) ?? null;
  /** 当前批次是否走 AI 管线（云端或本地，P3-01a：开始打标按钮对两者常显） */
  const isAiBatch = current?.mode === "cloud" || current?.mode === "local";
  const aiLabel = current?.mode === "local" ? "本地" : "云端";

  // FB6 需求一：派生页内进度 UI 状态（AiTaggingUiState）。
  // 收尾快照只在 running 翻转为 false 的一刻记录（完成/取消/失败显示静态最终状态，不继续滚动）。
  const [aiFinal, setAiFinal] = useState<{ status: string | null; error: string | null; processed: number; total: number } | null>(null);
  const prevRunning = useRef(false);
  useEffect(() => {
    if (prevRunning.current && !running && current) {
      setAiFinal({ status: current.status, error, processed: current.processed, total: current.total });
    }
    prevRunning.current = running;
    // 收尾快照只取 running 翻转那次渲染的 current/error（已是最新值）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);
  // 切批次：清空上一次的收尾快照与进度标记，避免旧批次的终态/素材名串台
  useEffect(() => {
    setAiFinal(null);
    setSawProgress(false);
  }, [currentBatchId]);

  const batchProcessed = current?.processed ?? 0;
  const batchTotal = current?.total ?? 0;
  const aiState: AiTaggingUiState = running
    ? cancelling
      ? { phase: "cancelling", processed: batchProcessed, total: batchTotal }
      : sawProgress
        ? { phase: "running", processed: batchProcessed, total: batchTotal, currentAssetId: lastProgressAssetId ?? undefined }
        : { phase: "starting", total: batchTotal }
    : aiFinal?.error
      ? { phase: "error", message: aiFinal.error, processed: aiFinal.processed, total: aiFinal.total }
      : aiFinal && (aiFinal.status === "done" || aiFinal.status === "cancelled")
        ? { phase: "done", processed: aiFinal.processed, total: aiFinal.total }
        : { phase: "idle" };

  /** LED 提示的当前素材名：按 lastProgressAssetId 从 suggestions 查；找不到只显示计数 */
  const aiCurrentName = useMemo(() => {
    if (lastProgressAssetId == null) return null;
    const hit = suggestions.find((s) => s.assetId === lastProgressAssetId);
    return hit ? assetFileLabel(hit.assetPath) : null;
  }, [suggestions, lastProgressAssetId]);

  // B-3：当前批次是否含视频 + 视频 AI 打标是否开启（前端提示，后端仍保留最终校验）
  const batchHasVideo = useMemo(
    () => suggestions.some((s) => (s.mimeType ?? "").startsWith("video/") || s.assetPath.match(/\.(mp4|mov|avi|mkv|webm|m4v)$/i) != null),
    [suggestions],
  );
  const videoTaggingOn = settings?.ai.videoTagging ?? false;
  // FB2-07（§13.6）：视频打标子模式与帧数（即时预览，随 settings 同步；批次启动时生效）
  const [videoMode, setVideoMode] = useState<"cover" | "frames">("cover");
  const [videoFrameCount, setVideoFrameCount] = useState(3);
  useEffect(() => {
    if (!settings) return;
    setVideoMode(settings.ai.videoTaggingMode === "frames" ? "frames" : "cover");
    setVideoFrameCount(settings.ai.videoFrameCount);
  }, [settings]);
  /** FB2-07：子模式/帧数改动即时落库（后端批次读 DB 配置），保存失败静默。 */
  const persistVideoMode = useCallback(
    (mode: "cover" | "frames", frameCount: number) => {
      if (!settings) return;
      void save({
        ...settings,
        ai: { ...settings.ai, videoTaggingMode: mode, videoFrameCount: frameCount },
      });
    },
    [settings, save],
  );
  const onSelectVideoMode = (m: "cover" | "frames") => {
    setVideoMode(m);
    persistVideoMode(m, videoFrameCount);
  };
  const onSelectVideoFrame = (n: number) => {
    setVideoFrameCount(n);
    persistVideoMode(videoMode, n);
  };
  // FB-03 §9.5：区分「设置未加载」与「真未开启」，避免加载失败误报
  const settingsUnloaded = settings === null;
  // B-1 批次统计语义：待生成 / 待确认 / 已确认 / 失败 分开，不再用「处理中」混淆多种状态。
  // 「全部确认」必须用「待确认建议」数量（computeAiStats.awaitingConfirmation），不能用待生成数。
  const stats = useMemo(() => computeAiStats(suggestions), [suggestions]);

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
    // 阶段 6 §9.4：把 AI 返回的分类显示名 key 归一化为稳定 facetKey（未知 → custom）
    // W3-2：knownFacetKeys 来自后端 facets —— 自建分面的 key 原样保留（未知才归 custom）
    setDraftTags(normalizeTagKeys(src, tagFacets.map((f) => f.key)));
    // 依赖含 suggestedTags 内容：批次跑完回载后 id/status 不变但标签已写入，
    // 若只依赖 [id, status] 当前张会停在旧的空 draft，此时点确认会写入空标签
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSuggestion?.id, currentSuggestion?.status, JSON.stringify(currentSuggestion?.suggestedTags)]);

  // FB5-05（§7.6）：当前张审核中的一句话描述（切张重置：确认值 → 素材当前值 → 建议值）
  const [draftDescription, setDraftDescription] = useState("");
  useEffect(() => {
    if (!currentSuggestion) return;
    setDraftDescription(pickReviewDescription(currentSuggestion));
  }, [currentSuggestion?.id, currentSuggestion?.status, currentSuggestion?.confirmedDescription, currentSuggestion?.suggestedDescription, currentSuggestion?.currentDescription]);

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

  // B-3：视频批次但视频打标未开启时跳转到设置页开启
  const openSettings = useCallback(() => {
    window.dispatchEvent(new CustomEvent("app:navigate", { detail: "settings" }));
  }, []);

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
    <div className="flex h-full bg-[var(--color-bg)]">
      {/* 左侧数据栏 */}
      <aside className="flex w-[252px] shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-bg)]">
        <div className="border-b border-[var(--color-border)] px-4 py-4">
          <h3 className="ui-section-title mb-3">
            打标模式
          </h3>
          <div className="grid grid-cols-2 rounded-[var(--radius-control)] bg-[var(--color-surface)] p-1 text-sm">
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
                  "rounded-md px-2 py-1.5 text-center text-xs font-medium transition-colors",
                  mode === m
                    ? "bg-[var(--color-surface-raised)] text-[var(--color-text)] shadow-sm"
                    : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {/* FB2-07（§13.6）：视频子打标模式 —— 仅当批次含视频且为 AI 模式时显示，纯图片批次不出现 */}
          {mode === "auto" && batchHasVideo && (
            <div className="mt-3">
              <div className="grid grid-cols-2 rounded-[var(--radius-control)] bg-[var(--color-surface)] p-1 text-sm">
                {(
                  [
                    ["cover", "封面打标"],
                    ["frames", "抽帧打标"],
                  ] as const
                ).map(([m, label]) => (
                  <button
                    key={m}
                    onClick={() => onSelectVideoMode(m)}
                    className={clsx(
                      "rounded-md px-2 py-1.5 text-center text-xs font-medium transition-colors",
                      videoMode === m
                        ? "bg-[var(--color-surface-raised)] text-[var(--color-text)] shadow-sm"
                        : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[10px] leading-4 text-[var(--color-text-secondary)]">
                {videoMode === "cover"
                  ? "复制入库封面零额外开销，每视频一次请求；未生成高清封面的视频用第一帧，夜景可能偏暗。"
                  : `抽 ${videoFrameCount} 帧分别识别后取多数标签，召回率更高；需要 ffmpeg，每个视频 ${videoFrameCount} 次请求。`}
              </p>
              {videoMode === "frames" && (
                <div className="mt-2 flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
                  <span>帧数</span>
                  <select
                    value={videoFrameCount}
                    onChange={(e) => onSelectVideoFrame(Math.max(2, Math.min(8, Number(e.target.value) || 3)))}
                    className="ui-control rounded-md bg-[var(--color-surface)] px-2 py-1 text-xs outline-none"
                  >
                    {[2, 3, 4, 5, 6, 8].map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                  <span>· {videoFrameCount} 次/视频</span>
                </div>
              )}
            </div>
          )}
          {mode === "auto" && (
              <p className="mt-2 text-[10px] leading-4 text-[var(--color-text-secondary)]">
                {activeProfile?.kind === "local"
                  ? `当前走本地服务（${activeProfile.name || "未命名"}）`
                  : "当前走云端 API；本地打标请到「设置 → 本地打标」配置本地模型并选中使用"}
              </p>
            )}
          {/* AI 批次启动区：不在运行中就常显「开始打标」（打完也保留，可续跑剩余 pending；v2.12） */}
          {isAiBatch && !running && (
            <div className="mt-4 flex flex-col gap-2">
              <label className="flex min-h-7 items-center gap-2 text-xs text-[var(--color-text-secondary)]">
                <input type="radio" checked={scopeAll} onChange={() => setScopeAll(true)} />
                打标全部（{current.total} 张）
              </label>
              <label className="flex min-h-7 items-center gap-2 text-xs text-[var(--color-text-secondary)]">
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
                  className="ui-control w-14 px-1.5 py-1 text-center text-xs"
                />
                张
              </label>
              {/* FB2-07（§13.6）：成本前置告知 —— 预估请求次数随批次规模/模式/帧数实时变化 */}
              <p className="text-[10px] leading-4 text-[var(--color-text-secondary)]">
                本批次约 {estimateRequests(stats, videoMode, videoFrameCount)} 次请求
                {stats.videoCount > 0 && `（含 ${stats.videoCount} 个视频 × ${videoMode === "frames" ? videoFrameCount : "封面"}）`}
              </p>
              <Button
                variant="primary"
                className="mt-1 w-full"
                disabled={
                  !scopeAll && (!scopeN || parseInt(scopeN, 10) < 1) || (batchHasVideo && !videoTaggingOn)
                }
                onClick={() => void startBatch(scopeAll ? undefined : parseInt(scopeN, 10))}
              >
                {batchHasVideo && !videoTaggingOn ? "先开启视频 AI 打标" : "开始打标"}
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
          <p className="mt-2 text-[10px] leading-4 text-[var(--color-text-tertiary)]">
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
          <div className="border-b border-[var(--color-border)] px-4 py-4">
            <h3 className="ui-section-title mb-3">
              当前模型
            </h3>
            {settings.ai.profiles.length === 0 ? (
              <div className="flex items-center gap-2">
                <p className="text-xs leading-5 text-[var(--color-text-secondary)]">
                  还没有 API 配置，去「设置 → AI 打标」添加中转站或本地服务
                </p>
                {/* W5f-f3：纯文字改跳转按钮 */}
                <button
                  type="button"
                  onClick={() => window.dispatchEvent(new CustomEvent("app:navigate", { detail: "settings" }))}
                  className="rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-xs font-medium text-[var(--color-accent-text)]"
                >
                  去设置添加
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <select
                  value={activeProfile?.id ?? ""}
                  onChange={(e) => switchProfile(e.target.value)}
                  className="ui-control w-full px-3 py-2 text-sm"
                >
                  {settings.ai.profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name || "未命名"}
                    </option>
                  ))}
                </select>
                {activeProfile && (
                  <LegacyProfileModelField
                    apiMode={activeProfile.apiMode}
                    kind={activeProfile.kind}
                    baseUrl={activeProfile.baseUrl}
                    apiKey={activeProfile.apiKey}
                    model={activeProfile.model}
                    onModelChange={changeModel}
                  />
                )}
              </div>
            )}
          </div>
        )}

        {current && (
          <div className="border-b border-[var(--color-border)] px-4 py-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="ui-section-title">当前批次</h3>
              <span className="text-[11px] text-[var(--color-text-tertiary)]">#{current.id} · 共 {suggestions.length} 张</span>
            </div>
            {/* B-3：批次含视频但视频打标未开启——明确提示并提供打开设置入口（前端预检 §9.3；后端保留最终校验） */}
            {batchHasVideo && !videoTaggingOn && !running && (
              <div className="mb-2 flex items-center gap-2 rounded-md border border-[var(--color-status)] bg-[var(--color-status-soft)] px-2.5 py-2 text-xs">
                <span className="min-w-0 flex-1 leading-4 text-[var(--color-status)]">
                  {settingsUnloaded
                    ? "设置尚未加载，无法判断「视频 AI 打标」是否开启；请稍后重试或先到设置页保存配置。"
                    : "视频 AI 打标未开启。请打开\"设置 → AI 设置 → 自动打标 → 视频 AI 打标\"，保存后重新开始批次。"}
                </span>
                <button
                  onClick={openSettings}
                  className="shrink-0 rounded-md border border-[var(--color-status)] px-2 py-1 font-medium text-[var(--color-status)] transition-colors hover:bg-[var(--color-status-soft)]"
                >
                  打开设置
                </button>
              </div>
            )}
            <div className="grid grid-cols-5 gap-1 rounded-[var(--radius-control)] bg-[var(--color-surface)] p-2 text-center">
              <div><strong className="block text-base font-medium text-[var(--color-text)]">{stats.total}</strong><span className="text-[10px] text-[var(--color-text-secondary)]">总数</span></div>
              <div><strong className="block text-base font-medium text-[var(--color-text-secondary)]">{stats.awaitingGeneration}</strong><span className="text-[10px] text-[var(--color-text-secondary)]">待生成</span></div>
              <div><strong className="block text-base font-medium text-[var(--color-status)]">{stats.awaitingConfirmation}</strong><span className="text-[10px] text-[var(--color-text-secondary)]">待确认</span></div>
              <div><strong className="block text-base font-medium text-[var(--color-text)]">{stats.confirmed}</strong><span className="text-[10px] text-[var(--color-text-secondary)]">已确认</span></div>
              <div><strong className="block text-base font-medium text-[var(--color-danger)]">{stats.failed}</strong><span className="text-[10px] text-[var(--color-text-secondary)]">失败</span></div>
            </div>
            {/* FB6 需求一：唯一页内进度条 + LED 滚动提示（starting 立即出现，不等后端事件） */}
            {aiState.phase !== "idle" && (
              <div className="mt-2">
                <AiTaggingProgress state={aiState} currentAssetName={aiCurrentName} />
                <p className="mt-1 text-[10px] text-[var(--color-text-secondary)]">
                  {current.mode === "manual" ? "手动模式：请逐张编辑标签" : `${aiLabel}生成建议 ${current.processed}/${current.total}`}
                </p>
              </div>
            )}
            {stats.awaitingConfirmation > 0 && !running && (
              <Button className="mt-2 w-full" variant="primary" onClick={() => void onConfirmAll()}>
                全部确认（{stats.awaitingConfirmation}）
              </Button>
            )}
            {current.mode !== "manual" && !running && stats.awaitingConfirmation === 0 && stats.awaitingGeneration === 0 && stats.failed === 0 && stats.total > 0 && (
              <p className="mt-2 text-[10px] leading-4 text-[var(--color-text-tertiary)]">
                当前没有待确认的建议；可逐张编辑标签后「确认写入」。
              </p>
            )}
          </div>
        )}

        {(batches.length > 0 || recentOps.length > 0) && (
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
            {batches.length > 0 && (
              <>
                <h3 className="ui-section-title mb-2 px-2">
                  历史批次
                </h3>
                {batches.map((b) => {
                  const statusLabel: Record<string, string> = {
                    pending: "待执行", processing: "进行中", done: "已完成", cancelled: "已取消", interrupted: "已中断", undone: "已撤销",
                  };
                  const canResume = b.status === "interrupted" || (b.status !== "processing" && b.status !== "undone" && b.processed < b.total);
                  // D-4：只有 done/cancelled 且存在可撤销写入的批次显示「撤销」；undone 不再显示
                  const canUndo = b.mode !== "manual" && (b.status === "done" || b.status === "cancelled") && b.confirmed > 0;
                  return (
                  <div key={b.id} className="flex items-center gap-1">
                    <button
                      onClick={() => {
                        setReviewIdx(0);
                        void openBatch(b.id);
                      }}
                      data-active={b.id === currentBatchId}
                      className="ui-nav-item min-w-0 flex-1 px-2.5 py-2 text-left text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
                    >
                      #{b.id} · {b.mode === "cloud" ? "云端" : b.mode === "manual" ? "手动" : "本地"} · {b.confirmed}/{b.total}
                      <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[var(--color-text-tertiary)]">
                        {new Date(b.createdAt).toLocaleDateString()}
                        <span className={clsx(
                          "rounded px-1 py-0.5 text-[9px]",
                          b.status === "interrupted"
                            ? "bg-[var(--color-status-soft)] text-[var(--color-status)]"
                            : "bg-[var(--color-surface)] text-[var(--color-text-tertiary)]",
                        )}>
                          {statusLabel[b.status] ?? b.status}
                        </span>
                      </span>
                    </button>
                    {canResume && !running && (
                      <button
                        onClick={() => void startBatch()}
                        title="继续执行剩余未打标项"
                        className="shrink-0 rounded px-1.5 py-1 text-[10px] font-medium text-[var(--color-status)] transition-colors hover:bg-[var(--color-surface)]"
                      >
                        继续
                      </button>
                    )}
                    {/* R-25：AI 批次撤销（两击确认；D-4：undone 不再显示可点击撤销） */}
                    {canUndo && (
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
                  );
                })}
              </>
            )}

            {/* R-25 最近打标：挂/摘流水，AI 来源带角标 */}
            {recentOps.length > 0 && (
              <>
                <h3 className="ui-section-title mt-4 mb-2 px-2">
                  最近打标
                </h3>
                {recentOps.map((o) => (
                  <div key={o.id} className="flex min-h-8 items-center gap-1 rounded-md px-2.5 py-1 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)]">
                    <span className={o.op === "add" ? "text-[var(--color-text)]" : "text-[var(--color-danger)]"}>
                      {o.op === "add" ? "＋" : "－"}
                    </span>
                    <span className="shrink-0 text-[var(--color-text)]">{o.tagName}</span>
                    <span className="min-w-0 flex-1 truncate opacity-70" title={o.assetName}>{o.assetName}</span>
                    {o.actor !== "manual" && (
                      <span className="shrink-0 rounded bg-[var(--color-status-soft)] px-1.5 py-0.5 text-[9px] text-[var(--color-status)]">AI</span>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </aside>

      {/* 右侧工作流：大图 → 胶片条 → EXIF → 标签 → 操作 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {error && <p className="px-4 pt-2 text-xs text-[var(--color-danger)]">{error}</p>}
        {saveError && <p className="px-4 pt-2 text-xs text-[var(--color-danger)]">配置保存失败：{saveError}</p>}

        {currentSuggestion ? (
          <>
            <Workbench
              suggestion={currentSuggestion}
              aiGroup={workbenchFacets.aiGroup}
              manualGroup={workbenchFacets.manualGroup}
              tags={draftTags}
              onTagsChange={setDraftTags}
              description={draftDescription}
              onDescriptionChange={setDraftDescription}
              index={idx}
              total={suggestions.length}
              filmstrip={
                <div className="relative shrink-0">
                  {selectedAssets.size > 0 && (
                    <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2">
                      <span className="text-xs text-[var(--color-text-secondary)]">已选 {selectedAssets.size} 张</span>
                      <button
                        onClick={() => void applyToSelected()}
                        disabled={applying || Object.keys(draftTags).length === 0}
                        className="rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-xs font-medium text-[var(--color-accent-text)] disabled:opacity-50"
                      >
                        {applying ? "套用中…" : "套用当前标签"}
                      </button>
                      <button
                        onClick={() => setSelectedAssets(new Set())}
                        className="rounded-md px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
                      >
                        取消
                      </button>
                    </div>
                  )}
                  <Filmstrip
                    suggestions={suggestions}
                    currentId={currentSuggestion.id}
                    selectedIds={selectedAssets}
                    onPick={onFilmPick}
                  />
                </div>
              }
              onGoto={goto}
              onConfirm={async () => {
                // FB5-05（§7.6）：确认时携带审核后的描述（同一事务写入素材）
                await confirm(currentSuggestion.id, draftTags, draftDescription);
                await afterWrite();
              }}
              onReject={async () => {
                await reject(currentSuggestion.id);
              }}
              onRestore={async () => {
                await restore(currentSuggestion.id);
              }}
            />

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
