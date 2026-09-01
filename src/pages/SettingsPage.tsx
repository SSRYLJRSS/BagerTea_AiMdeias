/** 设置页（指导书 §2.2/§6.1-§6.7）：
 *  左侧分组导航（含 AI 设置两个子页）+ 右侧分组内容；保存按钮在最后一项之后。
 *  IA：入库与总库 → AI 设置（超级搜索 AI/打标 AI）→ 标签与分类 → 通用外观 → 数据与缓存 → 关于。
 *  AI 子页内使用「在线服务/本地服务」二选一，只渲染当前模式字段。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { useShallow } from "zustand/react/shallow";
import { open as pickDir, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { on } from "@/api/client";
import Button from "@/components/common/Button";
import { ollamaInstallStatus, ollamaRemoveInstaller } from "@/api/ollama";
import { backupDb, clearThumbnailCache, getDataDir, openDataDir, openLogsDir, resetAppData, restoreDb, type ResetDataSelection } from "@/api/settings";
import {
  rescanAssetMetadata,
  rescanAssetPalette,
  rescanAssetPhash,
  cancelMediaRefill,
  getPaletteStatus,
  type RefillProgress,
  type PaletteStatus,
} from "@/api/assets";
import { listAiConnections, getAiUsageBindings, setAiUsageBinding } from "@/api/connections";
import { videoProxyCacheStats, clearAllVideoProxies } from "@/api/video";
import FacetManagePanel from "@/components/settings/FacetManagePanel";
import ServiceManagement from "@/components/settings/ServiceManagement";
import { useLibraryStore } from "@/stores/libraryStore";
import { applyTheme, useSettingsStore, DEFAULT_APPEARANCE } from "@/stores/settingsStore";
import { CELL_STEPS } from "@/types/settings";
import type { CellAspect, CellFit, Settings } from "@/types/settings";

/** FB2-01/02：素材框比例与填充可选项（顺序即展示顺序） */
const CELL_ASPECTS: { value: CellAspect; label: string }[] = [
  { value: "1:1", label: "1:1（方形）" },
  { value: "4:3", label: "4:3" },
  { value: "3:2", label: "3:2" },
  { value: "16:9", label: "16:9" },
  { value: "3:4", label: "3:4" },
  { value: "2:3", label: "2:3" },
  { value: "9:16", label: "9:16" },
];
const CELL_FITS: { value: CellFit; label: string }[] = [
  { value: "cover", label: "裁切填满（cover）" },
  { value: "contain", label: "完整显示（contain）" },
  { value: "smart", label: "智能（smart）" },
];

/** §6.1 路由状态：必须能表达 AI 的三个子页面（超级搜索 / 自动打标 / 服务管理） */
type SettingsRoute = "library" | "ai.superSearch" | "ai.tagging" | "ai.services" | "tags" | "general" | "data" | "about";

/** §6.1 分组顺序：不得调整 */
const GROUPS: {
  key: "library" | "ai" | "tags" | "general" | "data" | "about";
  label: string;
  children?: { key: SettingsRoute; label: string }[];
}[] = [
  { key: "library", label: "入库与总库" },
  {
    key: "ai",
    label: "AI 设置",
    children: [
      { key: "ai.superSearch", label: "超级搜索" },
      { key: "ai.tagging", label: "自动打标" },
      { key: "ai.services", label: "服务管理" },
    ],
  },
  { key: "tags", label: "标签与分类" },
  { key: "general", label: "通用外观" },
  { key: "data", label: "数据与缓存" },
  { key: "about", label: "关于" },
];

/** 初始分组：入库与总库（第一项） */
const DEFAULT_ROUTE: SettingsRoute = "library";

export default function SettingsPage({ onBack }: { onBack?: () => void }) {
  const { settings, loaded, loading, saving, load, save, loadError } = useSettingsStore(
    useShallow((s) => ({
      settings: s.settings,
      loaded: s.loaded,
      loading: s.loading,
      saving: s.saving,
      load: s.load,
      save: s.save,
      loadError: s.loadError,
    })),
  );
  const [draft, setDraft] = useState<Settings | null>(null);
  const [route, setRoute] = useState<SettingsRoute>(DEFAULT_ROUTE);
  const [dataDir, setDataDir] = useState("");
  const [dataDirError, setDataDirError] = useState(false);
  const [saved, setSaved] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A3：安装包缓存（「数据与缓存」分组展示占用/清理）
  const [installerInfo, setInstallerInfo] = useState<{ path: string; size: number } | null>(null);
  const [removingInstaller, setRemovingInstaller] = useState(false);
  // §6.7：视频代理缓存统计（数量/占用）+ 清理
  const [proxyStats, setProxyStats] = useState<{ count: number; bytes: number } | null>(null);
  const [clearingProxies, setClearingProxies] = useState(false);
  // 指导书 §7.5：媒体元数据批量回填（进度 + 取消）
  const [refillResult, setRefillResult] = useState<string | null>(null);
  const [refillProgress, setRefillProgress] = useState<RefillProgress | null>(null);
  const [refilling, setRefilling] = useState(false);
  const refillUnsub = useRef<(() => void) | null>(null);
  useEffect(() => () => refillUnsub.current?.(), []);

  const onRefill = async (scope: "all" | "missing") => {
    setRefilling(true);
    setRefillResult(null);
    setRefillProgress(null);
    // 订阅进度（非 Tauri 环境静默降级）
    on<RefillProgress>("media_refill://progress", (p) => setRefillProgress(p))
      .then((unsub) => {
        refillUnsub.current = unsub;
      })
      .catch(() => undefined);
    try {
      const r = await rescanAssetMetadata([], scope);
      setRefillResult(`回填完成：总数 ${r.total}，成功 ${r.success}，失败 ${r.failed}，跳过 ${r.skipped}`);
    } catch (e) {
      setRefillResult(e instanceof Error ? e.message : String(e));
    } finally {
      setRefilling(false);
      refillUnsub.current?.();
      refillUnsub.current = null;
      setRefillProgress(null);
    }
  };
  const onCancelRefill = () => {
    void cancelMediaRefill().catch(() => undefined);
    setRefillResult("正在取消…");
  };

  // FB2-08：算法色板回算（与元数据回填互斥，见 FX-12；进度事件同频道，互斥保证不混淆）
  const [paletteResult, setPaletteResult] = useState<string | null>(null);
  const [paletteProgress, setPaletteProgress] = useState<RefillProgress | null>(null);
  const [paletteRunning, setPaletteRunning] = useState(false);
  const paletteUnsub = useRef<(() => void) | null>(null);
  useEffect(() => () => paletteUnsub.current?.(), []);
  const onRescanPalette = async (scope: "all" | "missing") => {
    setPaletteRunning(true);
    setPaletteResult(null);
    setPaletteProgress(null);
    // 独立订阅，不复用 refillUnsub：两个订阅同时活着时复用 ref 会互相覆盖，导致其中一个泄漏
    on<RefillProgress>("media_refill://progress", (p) => setPaletteProgress(p))
      .then((unsub) => {
        paletteUnsub.current = unsub;
      })
      .catch(() => undefined);
    try {
      const r = await rescanAssetPalette([], scope);
      setPaletteResult(`回算完成：总数 ${r.total}，成功 ${r.success}，跳过 ${r.skipped}，失败 ${r.failed}`);
    } catch (e) {
      setPaletteResult(e instanceof Error ? e.message : String(e));
    } finally {
      setPaletteRunning(false);
      paletteUnsub.current?.();
      paletteUnsub.current = null;
      setPaletteProgress(null);
    }
  };

  // ── W5d（§W5d）：感知哈希存量回填（与色板回算互斥：同一 refill_running 闸）──
  const [phashRunning, setPhashRunning] = useState(false);
  const phashUnsub = useRef<(() => void) | null>(null);
  const [phashProgress, setPhashProgress] = useState<RefillProgress | null>(null);
  const [phashResult, setPhashResult] = useState<string | null>(null);
  useEffect(() => () => phashUnsub.current?.(), []);

  const onRescanPhash = async (scope: "all" | "missing") => {
    setPhashRunning(true);
    setPhashResult(null);
    setPhashProgress(null);
    on<RefillProgress>("media_refill://progress", (p) => setPhashProgress(p))
      .then((unsub) => {
        phashUnsub.current = unsub;
      })
      .catch(() => undefined);
    try {
      const r = await rescanAssetPhash([], scope);
      setPhashResult(`感知哈希回填完成：总数 ${r.total}，成功 ${r.success}，跳过 ${r.skipped}，失败 ${r.failed}`);
    } catch (e) {
      setPhashResult(e instanceof Error ? e.message : String(e));
    } finally {
      setPhashRunning(false);
      phashUnsub.current?.();
      phashUnsub.current = null;
      setPhashProgress(null);
    }
  };

  // ── FB4-03（§4.5/§6.3）：色板状态行 + 「生成缺失色条」手动流程 ──
  const [paletteStatus, setPaletteStatus] = useState<PaletteStatus | null>(null);
  const [paletteStatusError, setPaletteStatusError] = useState<string | null>(null);
  const [generatingMissing, setGeneratingMissing] = useState(false);
  const [generateProgress, setGenerateProgress] = useState<RefillProgress | null>(null);
  const [generateResult, setGenerateResult] = useState<string | null>(null);
  /** W4-5：色条细节折叠（默认收起） */
  const [showColorDetails, setShowColorDetails] = useState(false);
  const generateUnsub = useRef<(() => void) | null>(null);
  useEffect(() => () => generateUnsub.current?.(), []);

  /** FB4-03：重新读取色板状态（进入通用外观路由时调用；失败保留错误文案 + 重试入口）。 */
  const refreshPaletteStatus = useCallback(async () => {
    try {
      const st = await getPaletteStatus();
      setPaletteStatus(st);
      setPaletteStatusError(null);
    } catch (e) {
      setPaletteStatusError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // 进入通用外观路由时读取状态；总开关开关变化不需要重复触发扫描（§6.3）
  useEffect(() => {
    if (route !== "general") return;
    void refreshPaletteStatus();
  }, [route, refreshPaletteStatus]);

  /** FB4-03：生成缺失色条 —— 手动回算不发 palette://updated 全局事件；
   *  resolve 后不得调用 libraryStore.refresh()；状态刷新与局部同步即使失败也保留摘要并显示具体错误。 */
  const onGenerateMissingPalette = async () => {
    if (generatingMissing || paletteRunning || refilling) return;
    setGeneratingMissing(true);
    setGenerateResult(null);
    setGenerateProgress(null);
    on<RefillProgress>("media_refill://progress", (p) => setGenerateProgress(p))
      .then((unsub) => {
        generateUnsub.current = unsub;
      })
      .catch(() => undefined);
    try {
      const r = await rescanAssetPalette([], "missing");
      setGenerateResult(
        `生成完成：成功 ${r.success}，跳过 ${r.skipped}，失败 ${r.failed}（共处理 ${r.total}）`,
      );
      // 随后重新读取状态 + 定向同步色板字段；任一失败也要保留摘要并给出具体错误
      const errors: string[] = [];
      try {
        await refreshPaletteStatus();
      } catch (e) {
        errors.push(`状态刷新失败：${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        await useLibraryStore.getState().refreshPaletteFields(r.updatedIds);
      } catch (e) {
        errors.push(`素材色条同步失败：${e instanceof Error ? e.message : String(e)}`);
      }
      if (errors.length > 0) {
        setPaletteStatusError(errors.join("；"));
      }
    } catch (e) {
      // 互斥闸被占用（FX-12）/ 一般错误：明确展示，不轮询不自动重试
      setGenerateResult(e instanceof Error ? e.message : String(e));
    } finally {
      setGeneratingMissing(false);
      generateUnsub.current?.();
      generateUnsub.current = null;
      setGenerateProgress(null);
    }
  };

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  useEffect(() => {
    if (settings && !draft) setDraft(structuredClone(settings));
  }, [settings, draft]);

  useEffect(() => {
    // A-3：数据目录读取失败只显示「暂不可用」，不抛出到页面边界
    getDataDir()
      .then((dir) => {
        setDataDir(dir);
        setDataDirError(false);
      })
      .catch(() => setDataDirError(true));
  }, []);

  // 进入「数据与缓存」分组时刷新安装包缓存 + 视频代理缓存统计
  useEffect(() => {
    if (route !== "data") return;
    ollamaInstallStatus()
      .then((s) =>
        s.installerPath ? setInstallerInfo({ path: s.installerPath, size: s.installerSize }) : setInstallerInfo(null),
      )
      .catch(() => setInstallerInfo(null));
    videoProxyCacheStats()
      .then(([count, bytes]) => setProxyStats({ count, bytes }))
      .catch(() => setProxyStats(null));
  }, [route]);

  const onClearVideoProxies = async () => {
    setClearingProxies(true);
    try {
      const removed = await clearAllVideoProxies();
      setNotice(removed > 0 ? `已清理 ${removed} 个视频代理文件` : "视频代理缓存已清理");
      const [count, bytes] = await videoProxyCacheStats();
      setProxyStats({ count, bytes });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setClearingProxies(false);
    }
  };

  const onRemoveInstaller = async () => {
    setRemovingInstaller(true);
    try {
      await ollamaRemoveInstaller();
      setInstallerInfo(null);
      setNotice("Ollama 安装包已删除");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRemovingInstaller(false);
    }
  };

  if (!draft) {
    // P2-03：加载失败不能永久停留在「加载设置中…」——给出错误与重试入口
    if (loadError) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-sm">
          <p className="text-[var(--color-danger)]">设置加载失败：{loadError}</p>
          <Button onClick={() => void load()}>重试</Button>
          <p className="text-xs text-[var(--color-text-secondary)]">
            加载成功前设置页不可编辑，避免覆盖真实配置
          </p>
        </div>
      );
    }
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-secondary)]">
        {loading ? "加载设置中…" : "准备加载…"}
      </div>
    );
  }

  const dirty = (next: Settings) => {
    setDraft(next);
    setSaved(false);
  };
  const isDirty = !!settings && JSON.stringify(draft) !== JSON.stringify(settings);
  const patchAi = (patch: Partial<Settings["ai"]>) => dirty({ ...draft, ai: { ...draft.ai, ...patch } });

  // W3：aiFacetConfigs 草稿路径已删（V20 合表后分面语义在 tag_facets.input_mode，
  // FacetManagePanel 直接读写库；此处不再维护第二份草稿）

  // FB2-01/02（§8.4）：素材框外观 —— draft.appearance 兜底默认；改动同时写 draft 与 previewAppearance（即时预览）
  const draftAppearance = draft.appearance ?? DEFAULT_APPEARANCE;
  const pushPreview = (appearance: Settings["appearance"]) => {
    useSettingsStore.getState().commitAppearanceDebounced(appearance);
  };
  const patchGrid = (grid: Settings["appearance"]["grid"]) => {
    const next: Settings = { ...draft, appearance: { ...draftAppearance, grid } };
    dirty(next);
    pushPreview(next.appearance);
  };
  // FB2-08（§14.11）：色条设置 —— 与 patchGrid 同形；每个 onChange 都 dirty + pushPreview（即时预览纪律）
  const patchColorStrip = (patch: Partial<Settings["appearance"]["colorStrip"]>) => {
    const next: Settings = {
      ...draft,
      appearance: { ...draftAppearance, colorStrip: { ...draftAppearance.colorStrip, ...patch } },
    };
    dirty(next);
    pushPreview(next.appearance);
  };

  const chooseLibraryRoot = async () => {
    const dir = await pickDir({ directory: true });
    if (typeof dir === "string") dirty({ ...draft, libraryRoot: dir });
  };

  const onClearCache = async () => {
    setNotice(null);
    setError(null);
    try {
      await clearThumbnailCache("hd");
      setNotice("高清缩略图缓存已清除");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onSave = async () => {
    setError(null);
    try {
      await save(draft);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const aiRoute: "ai.superSearch" | "ai.tagging" | null =
    route === "ai.superSearch" || route === "ai.tagging" ? route : null;

  return (
    <div className="flex h-full">
      {/* 左侧分组导航（§13 FB-07：220~260px） */}
      <aside className="w-[224px] shrink-0 border-r border-[var(--color-border)] lg:w-[248px]">
        {onBack && (
          <button
            onClick={onBack}
            className="w-full border-b border-[var(--color-border)] px-3 py-2 text-left text-sm text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
          >
            ← 返回
          </button>
        )}
        <div className="p-2">
          {GROUPS.map((g) => {
            const active = route === g.key || (g.children?.some((c) => c.key === route) ?? false);
            const aiExpanded = g.key === "ai" && route.startsWith("ai.");
            return (
              <div key={g.key}>
                <button
                  onClick={() => setRoute(g.children ? (g.children[0].key as SettingsRoute) : (g.key as SettingsRoute))}
                  className={clsx(
                    "block w-full rounded px-2 py-1.5 text-left text-sm transition-colors",
                    active
                      ? "bg-[var(--color-surface)] font-medium text-[var(--color-text)]"
                      : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]",
                  )}
                >
                  {g.label}
                </button>
                {g.children && aiExpanded && (
                  <div className="ml-2 flex flex-col border-l border-[var(--color-border)] pl-2">
                    {g.children.map((c) => (
                      <button
                        key={c.key}
                        onClick={() => setRoute(c.key)}
                        className={clsx(
                          "block w-full rounded px-2 py-1 text-left text-sm transition-colors",
                          route === c.key
                            ? "bg-[var(--color-surface)] font-medium text-[var(--color-text)]"
                            : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]",
                        )}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>

      {/* 右侧分组内容（§13 FB-07：取消 max-w-xl 小框，宽屏充分利用） */}
      <div className="relative min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1040px] flex-col gap-6 px-6 py-6">
          {route === "library" && (
            <Group title="入库与总库">
              <Field label="总库位置" hint="配置后，入库将把文件复制到 总库/分库/ 下统一管理；留空 = 原位索引">
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    value={draft.libraryRoot}
                    placeholder="未配置"
                    className="ui-control w-52 rounded-md px-2 py-1.5 text-sm outline-none"
                  />
                  <Button onClick={chooseLibraryRoot}>选择…</Button>
                  {draft.libraryRoot && (
                    <Button onClick={() => dirty({ ...draft, libraryRoot: "" })}>清除</Button>
                  )}
                </div>
              </Field>
              {/* W4-5：删「分库与改名」说明行（那是入库页的操作说明，不是设置） */}
            </Group>
          )}

          {aiRoute && (
            <AiPurposePanel
              usage={aiRoute}
              draft={draft}
              patchAi={patchAi}
              notify={setNotice}
              fail={setError}
              onOpenServices={() => setRoute("ai.services")}
            />
          )}

          {route === "ai.services" && (
            <Group title="服务管理">
              <ServiceManagement
                draft={draft}
                onPatchAi={patchAi}
                onPatchSettings={(patch) => dirty({ ...draft, ...patch })}
                notify={setNotice}
                fail={setError}
              />
            </Group>
          )}

          {route === "tags" && (
            <Group title="标签与分类">
              {/* §9.2/§9.5：分面结构 + AI 行为 + 分类词条在同一个分面详情内完成；
                   不再并列「AI 行为配置」独立列表与「分类词条」顶层卡片（§9.3） */}
              <div className="p-2">
                <FacetManagePanel draft={draft} onPatchAi={patchAi} />
              </div>
            </Group>
          )}

          {route === "general" && (
            <>
              <Group title="通用外观">
              {/* W5h：同源文件组（RAW+JPG）两个开关 —— 打标层默认开、浏览层默认关（用户定案） */}
              <Field
                label="同源文件打标同步"
                hint="同一张照片的 RAW+JPG 只打一次标：AI 批次自动去重（请求减半），确认后标签自动同步到另一份"
              >
                <Toggle
                  checked={draftAppearance.kinship?.syncTagsToSiblings ?? true}
                  onChange={(v) => {
                    const next: Settings = {
                      ...draft,
                      appearance: { ...draftAppearance, kinship: { ...draftAppearance.kinship, syncTagsToSiblings: v } },
                    };
                    dirty(next);
                    pushPreview(next.appearance);
                  }}
                />
              </Field>
              <Field
                label="素材库合并显示同源文件"
                hint="开启后每组 RAW+JPG 只显示一个（非 RAW 优先）；关闭则两份都显示。注意：合并显示下顶栏计数仍为后端总数"
              >
                <Toggle
                  checked={draftAppearance.kinship?.mergeInLibrary ?? false}
                  onChange={(v) => {
                    const next: Settings = {
                      ...draft,
                      appearance: { ...draftAppearance, kinship: { ...draftAppearance.kinship, mergeInLibrary: v } },
                    };
                    dirty(next);
                    pushPreview(next.appearance);
                  }}
                />
              </Field>
              <Field label="主题" hint="跟随系统 / 浅色 / 深色；切换即时预览，保存后记住">
                <select
                  value={draft.theme}
                  onChange={(e) => {
                    const t = e.target.value as Settings["theme"];
                    applyTheme(t); // R-24：即时预览，不等保存
                    dirty({ ...draft, theme: t });
                  }}
                  className="ui-control rounded-md px-2 py-1.5 text-sm outline-none"
                >
                  <option value="system">跟随系统</option>
                  <option value="light">浅色</option>
                  <option value="dark">深色</option>
                </select>
              </Field>
            </Group>

            {/* FB2-02（§8.4）：素材框 —— 统一比例 + 填充方式 + 双边格子大小 + 悬停预览。
                所有外观字段即时生效（写 draft + previewAppearance），保存时随 draft 落库。 */}
            <Group title="素材框">
              <Field label="统一比例" hint="素材库与入库网格共用同一比例，任意混排都无锯齿行">
                <select
                  value={draft.appearance?.grid.cellAspect ?? "1:1"}
                  onChange={(e) => {
                    const next: Settings = {
                      ...draft,
                      appearance: { ...draftAppearance, grid: { ...draftAppearance.grid, cellAspect: e.target.value as CellAspect } },
                    };
                    dirty(next);
                    pushPreview(next.appearance);
                  }}
                  className="ui-control rounded-md px-2 py-1.5 text-sm outline-none"
                >
                  {CELL_ASPECTS.map((a) => (
                    <option key={a.value} value={a.value}>{a.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="填充方式" hint="cover 裁切填满 / contain 完整显示 / smart 按内容自动权衡，绝不拉伸">
                <select
                  value={draftAppearance.grid.cellFit}
                  onChange={(e) => {
                    const next: Settings = {
                      ...draft,
                      appearance: { ...draftAppearance, grid: { ...draftAppearance.grid, cellFit: e.target.value as CellFit } },
                    };
                    dirty(next);
                    pushPreview(next.appearance);
                  }}
                  className="ui-control rounded-md px-2 py-1.5 text-sm outline-none"
                >
                  {CELL_FITS.map((f) => (
                    <option key={f.value} value={f.value}>{f.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="contain 留边填主色" hint="将留边底色填成素材主色的低饱和版本（视觉延伸，非缺口）">
                <Toggle
                  checked={draft.appearance.grid.matchDominantColor}
                  onChange={() => {
                    const next: Settings = {
                      ...draft,
                      appearance: { ...draftAppearance, grid: { ...draftAppearance.grid, matchDominantColor: !draftAppearance.grid.matchDominantColor } },
                    };
                    dirty(next);
                    pushPreview(next.appearance);
                  }}
                />
              </Field>
              <Field label="素材库格子大小" hint="档位化缩放；Alt/Ctrl/Cmd+滚轮或 Ctrl/Cmd+± 也可调整">
                <RangeSteps value={draftAppearance.grid.libraryCellStep} max={CELL_STEPS.length - 1} labelForStep={(i) => `${CELL_STEPS[i]}px`} onChange={(v) => patchGrid({ ...draftAppearance.grid, libraryCellStep: v })} />
              </Field>
              <Field label="入库格子大小" hint="入库页网格的默认档位（两页各存一份）">
                <RangeSteps value={draftAppearance.grid.importCellStep} max={CELL_STEPS.length - 1} labelForStep={(v) => `${CELL_STEPS[v]}px`} onChange={(v) => patchGrid({ ...draftAppearance.grid, importCellStep: v })} />
              </Field>
              <Field label="悬停自动播放" hint="鼠标停在视频卡片上约 300 毫秒后，在卡片内部静音播放片段；移开鼠标立即停止，不会打开大浮层">
                <Toggle
                  checked={draftAppearance.hoverPreview.enabled}
                  onChange={() => {
                    const hp = { ...draftAppearance.hoverPreview, enabled: !draftAppearance.hoverPreview.enabled };
                    const next: Settings = { ...draft, appearance: { ...draftAppearance, hoverPreview: hp } };
                    dirty(next);
                    pushPreview(next.appearance);
                  }}
                />
              </Field>
              {draftAppearance.hoverPreview.enabled && (
                <Field label="预览时长" hint="预览播放的片段长度（秒），2–10">
                  <input
                    type="number"
                    min={2}
                    max={10}
                    className="ui-control w-20 rounded-md px-2 py-1.5 text-sm outline-none"
                    value={String(draftAppearance.hoverPreview.previewSeconds)}
                    onChange={(v) => {
                      const n = Math.max(2, Math.min(10, Number(v.target.value) || 2));
                      const next: Settings = { ...draft, appearance: { ...draftAppearance, hoverPreview: { ...draftAppearance.hoverPreview, previewSeconds: n } } };
                      dirty(next);
                      pushPreview(next.appearance);
                    }}
                  />
                </Field>
              )}
              {draftAppearance.hoverPreview.enabled && (
                <Field label="素材库也启用悬停预览" hint="默认只在素材库悬停播放；关闭后素材库仅显示封面（设置只影响素材库网格，查看器内播放不受此开关控制）">
                  <Toggle
                    checked={draftAppearance.hoverPreview.inLibraryGrid}
                    onChange={() => {
                      const next: Settings = { ...draft, appearance: { ...draftAppearance, hoverPreview: { ...draftAppearance.hoverPreview, inLibraryGrid: !draftAppearance.hoverPreview.inLibraryGrid } } };
                      dirty(next);
                      pushPreview(next.appearance);
                    }}
                  />
                </Field>
              )}
              {/* FB2-08（§14.11）+ FB3-10（§12.2）+ FB4-03（§4.5）：算法主色色条设置。
                  总开关关闭时位置/样式行不渲染；状态行（色条数据）即使总开关关闭也显示。 */}
              <Field label="显示算法主色色条" hint="从图片或视频封面中提取几种主要颜色，仅在本机计算，不调用 AI">
                <Toggle
                  checked={draftAppearance.colorStrip.enabled}
                  onChange={(v) => patchColorStrip({ enabled: v })}
                />
              </Field>
              {/* FB4-03：色板状态行 + 生成缺失色条（不随总开关隐藏；让用户先知道库里是否有可用色板） */}
              <Field label="色条数据" hint="只处理尚未生成或数据损坏的素材，不重复计算已有有效色板">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  {paletteStatusError ? (
                    <span className="text-xs text-[var(--color-danger)]">
                      {paletteStatusError}
                      <button
                        type="button"
                        onClick={() => void refreshPaletteStatus()}
                        className="ml-2 underline decoration-dotted underline-offset-2"
                      >
                        重试
                      </button>
                    </span>
                  ) : paletteStatus === null ? (
                    <span className="text-xs text-[var(--color-text-secondary)]">正在检查色条数据…</span>
                  ) : (
                    <>
                      <span className="text-xs text-[var(--color-text-secondary)]">
                        {paletteStatus.missing > 0
                          ? `已生成 ${paletteStatus.ready} / 可生成 ${paletteStatus.eligible}；另有 ${paletteStatus.unavailable} 项暂不可生成`
                          : paletteStatus.eligible === 0
                            ? "当前没有可生成色条的图片或视频封面"
                            : `已生成 ${paletteStatus.ready} / 可生成 ${paletteStatus.eligible}；所有可生成素材均已完成`}
                      </span>
                      {paletteStatus.missing > 0 && !generatingMissing && (
                        <Button
                          disabled={paletteRunning || refilling}
                          onClick={() => void onGenerateMissingPalette()}
                        >
                          生成缺失色条（{paletteStatus.missing}）
                        </Button>
                      )}
                      {generatingMissing && (
                        <Button
                          onClick={() => {
                            void cancelMediaRefill().catch(() => undefined);
                            setGenerateResult("正在取消…");
                          }}
                        >
                          取消
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </Field>
              {generateProgress && generatingMissing && (
                <p className="px-4 py-2 text-xs text-[var(--color-text-secondary)]">
                  生成中 {generateProgress.done}/{generateProgress.total}（成功 {generateProgress.success} · 跳过 {generateProgress.skipped} · 失败 {generateProgress.failed}）
                </p>
              )}
              {generateResult && (
                <p className="px-4 py-2 text-xs text-[var(--color-text-secondary)]">{generateResult}</p>
              )}
              {/* W4-5：色条细节折叠（7 控件压成 1 开关 + 折叠，通用外观可见控件 ≤12） */}
              {draftAppearance.colorStrip.enabled && (
                <div className="px-4 py-1">
                  <button
                    type="button"
                    onClick={() => setShowColorDetails((v) => !v)}
                    className="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
                  >
                    ▸ 色条细节{showColorDetails ? "（收起）" : ""}
                  </button>
                  {showColorDetails && (
                    <div className="mt-1 flex flex-col gap-1">
                <Field label="素材库卡片显示" hint="在素材缩略图卡片底部显示色条">
                    <Toggle
                      checked={draftAppearance.colorStrip.showInLibraryGrid}
                      onChange={(v) => patchColorStrip({ showInLibraryGrid: v })}
                    />
                  </Field>
                <Field label="大图浏览显示" hint="在大图浏览的标签栏上方显示色条；全屏时隐藏">
                    <Toggle
                      checked={draftAppearance.colorStrip.showInViewer}
                      onChange={(v) => patchColorStrip({ showInViewer: v })}
                    />
                  </Field>
                <Field label="色条高度" hint="网格用细、大图用厚">
                    <select
                      value={draftAppearance.colorStrip.height}
                      onChange={(e) => patchColorStrip({ height: e.target.value as Settings["appearance"]["colorStrip"]["height"] })}
                      className="ui-control rounded-md px-2 py-1.5 text-sm outline-none"
                    >
                      <option value="thin">细 6px</option>
                      <option value="normal">标准 10px</option>
                      <option value="thick">厚 16px</option>
                    </select>
                  </Field>
                <Field label="分段方式" hint="按占比更能体现调性；等宽接近调色参考站的观感">
                    <select
                      value={draftAppearance.colorStrip.mode}
                      onChange={(e) => patchColorStrip({ mode: e.target.value as Settings["appearance"]["colorStrip"]["mode"] })}
                      className="ui-control rounded-md px-2 py-1.5 text-sm outline-none"
                    >
                      <option value="ratio">按占比</option>
                      <option value="equal">等宽</option>
                    </select>
                  </Field>
                <Field label="显示条数" hint="色条最多显示前 N 个主色">
                    <select
                      value={String(draftAppearance.colorStrip.count)}
                      onChange={(e) => patchColorStrip({ count: Number(e.target.value) as Settings["appearance"]["colorStrip"]["count"] })}
                      className="ui-control rounded-md px-2 py-1.5 text-sm outline-none"
                    >
                      <option value="4">4</option>
                      <option value="6">6</option>
                      <option value="8">8</option>
                    </select>
                  </Field>
                    </div>
                  )}
                </div>
              )}
            </Group>
            </>
          )}

          {route === "data" && (
            <Group title="数据与缓存">
              <Field label="软件数据保存位置" hint="数据库与缩略图所在目录，备份/转移素材库时复制此目录">
                <div className="flex items-center gap-2">
                  <span className="max-w-52 truncate text-xs text-[var(--color-text-secondary)]" title={dataDir}>
                    {dataDirError ? "暂不可用" : dataDir || "…"}
                  </span>
                  <Button onClick={() => void openDataDir()}>打开文件夹</Button>
                </div>
              </Field>
              <Field label="高清缩略图缓存" hint="浏览大图时生成的清晰版缩略图。删除后会按需重新生成，不影响原文件；上限超出后自动清理最久未用的">
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    className="ui-control w-20 rounded-md px-2 py-1.5 text-sm outline-none"
                    value={String(draft.thumbnailCacheMb)}
                    onChange={(v) => dirty({ ...draft, thumbnailCacheMb: Math.max(0, Number(v.target.value) || 0) })}
                  />
                  <Button onClick={() => void onClearCache()}>立即清除</Button>
                </div>
              </Field>
              <Field
                label="Ollama 安装包缓存"
                hint={
                  installerInfo
                    ? `约 ${(installerInfo.size / 1024 / 1024).toFixed(0)} MB，供离线重装；删除后需重新下载`
                    : "未缓存安装包（一键安装时自动下载）"
                }
              >
                {installerInfo && (
                  <Button variant="danger" disabled={removingInstaller} onClick={() => void onRemoveInstaller()}>
                    {removingInstaller ? "删除中…" : "删除安装包"}
                  </Button>
                )}
              </Field>
              <Field label="回收站" hint="超期后启动时自动彻底清理；0 = 不自动清理">
                <input
                  type="number"
                  className="ui-control w-20 rounded-md px-2 py-1.5 text-sm outline-none"
                  value={String(draft.trashRetentionDays)}
                  onChange={(v) => dirty({ ...draft, trashRetentionDays: Math.max(0, Number(v.target.value) || 0) })}
                />
              </Field>
              <Field
                label="媒体元数据回填"
                hint="重新读取文件本身的技术信息（分辨率、编码、时长、帧率、音频编码、拍摄参数），不改变原文件和标签。适用：旧素材导入时读取失败、程序升级后新增字段、视频时长显示为空。失败会记录原因，不阻塞其他素材"
              >
                <div className="flex items-center gap-2">
                  {/* 与色板回算互斥（FX-12 后端也会拒绝）；前端 disabled 是为了不让用户点了才知道 */}
                  <Button disabled={refilling || paletteRunning} onClick={() => void onRefill("missing")}>
                    只补缺失信息
                  </Button>
                  <Button disabled={refilling || paletteRunning} onClick={() => void onRefill("all")}>
                    重新读取全部视频
                  </Button>
                  {refilling ? (
                    <Button onClick={onCancelRefill}>取消</Button>
                  ) : null}
                </div>
              </Field>
              {refillProgress && refilling && (
                <p className="px-4 py-2 text-xs text-[var(--color-text-secondary)]">
                  回填中 {refillProgress.done}/{refillProgress.total}（成功 {refillProgress.success} · 失败 {refillProgress.failed} · 跳过 {refillProgress.skipped}）
                </p>
              )}
              {refillResult && (
                <p className="px-4 py-2 text-xs text-[var(--color-text-secondary)]">{refillResult}</p>
              )}
              {/* FB2-08（§14.7）+ FB3-11（§13.2）：算法色板回算（白话说明 + 危险性写清） */}
              <Field
                label="算法色板回算"
                hint="用本地算法从图片或视频封面估算主色，生成色条和按颜色筛选所需的索引。不调用 AI，不会创建标签。只补缺失＝只处理还没有色板的素材（快）；全部重算＝覆盖旧色板（适合算法升级或结果明显不准时）。视频需要先浏览过（生成封面）才能算，没有封面的会计入「跳过」"
              >
                <div className="flex items-center gap-2">
                  <Button disabled={paletteRunning || refilling} onClick={() => void onRescanPalette("missing")}>
                    只补缺失色板
                  </Button>
                  <Button disabled={paletteRunning || refilling} onClick={() => void onRescanPalette("all")}>
                    全部重新计算
                  </Button>
                  {paletteRunning ? (
                    <Button
                      onClick={() => {
                        void cancelMediaRefill().catch(() => undefined);
                        setPaletteResult("正在取消…");
                      }}
                    >
                      取消
                    </Button>
                  ) : null}
                </div>
              </Field>
              {paletteProgress && paletteRunning && (
                <p className="px-4 py-2 text-xs text-[var(--color-text-secondary)]">
                  色板回算中 {paletteProgress.done}/{paletteProgress.total}（成功 {paletteProgress.success} · 跳过 {paletteProgress.skipped} · 失败 {paletteProgress.failed}）
                </p>
              )}
              {paletteResult && (
                <p className="px-4 py-2 text-xs text-[var(--color-text-secondary)]">{paletteResult}</p>
              )}
              {/* W5d（§W5d）：感知哈希回填（相似图去重的前提；新导入的图片已自动计算，这里只补存量） */}
              <Field
                label="感知哈希回填"
                hint="用本地算法给图片算感知哈希（dHash），供「查找重复素材 → 相似图」识别连拍/同画面。新导入的图片已自动计算；这里只处理升级前导入的存量。只补缺失＝只处理还没有哈希的图片（快）；全部重算＝覆盖已有哈希（适合算法升级后）。纯本地计算，不调 AI"
              >
                <div className="flex items-center gap-2">
                  <Button disabled={phashRunning || paletteRunning || refilling} onClick={() => void onRescanPhash("missing")}>
                    只补缺失哈希
                  </Button>
                  <Button disabled={phashRunning || paletteRunning || refilling} onClick={() => void onRescanPhash("all")}>
                    全部重算
                  </Button>
                  {phashRunning ? (
                    <Button
                      onClick={() => {
                        void cancelMediaRefill().catch(() => undefined);
                        setPhashResult("正在取消…");
                      }}
                    >
                      取消
                    </Button>
                  ) : null}
                </div>
              </Field>
              {phashProgress && phashRunning && (
                <p className="px-4 py-2 text-xs text-[var(--color-text-secondary)]">
                  感知哈希回填中 {phashProgress.done}/{phashProgress.total}（成功 {phashProgress.success} · 跳过 {phashProgress.skipped} · 失败 {phashProgress.failed}）
                </p>
              )}
              {phashResult && (
                <p className="px-4 py-2 text-xs text-[var(--color-text-secondary)]">{phashResult}</p>
              )}
              <Field
                label="视频代理缓存"
                hint={
                  proxyStats && proxyStats.count > 0
                    ? `原视频编码不兼容时生成的 H.264/AAC 临时副本（当前 ${proxyStats.count} 个，约 ${(proxyStats.bytes / 1024 / 1024).toFixed(1)} MB）。清理不删除原视频，需要时会重新生成`
                    : "原视频播放不兼容时按需生成 H.264/AAC MP4 临时副本；清理不删除原视频。暂无可清理的代理"
                }
              >
                <Button variant="danger" disabled={clearingProxies} onClick={() => void onClearVideoProxies()}>
                  {clearingProxies ? "清理中…" : "清理全部"}
                </Button>
              </Field>
              {/* W5c：数据库备份/恢复（指导书 §W5c）——你的库唯一的副本入口 */}
              <Field
                label="数据库备份与恢复"
                hint="备份把整个素材库导出成一个 .db 文件（含素材记录、标签、AI 配置），建议存到移动硬盘或网盘；恢复会用备份文件整体替换当前库，恢复后软件自动重启"
              >
                <BackupRestorePanel notify={setNotice} fail={setError} />
              </Field>
              <ResetDataPanel
                notify={setNotice}
                fail={setError}
                onDataReset={async (sel) => {
                  // 偏好设置被重置：重新拉取设置并替换 draft（draft 已存在，load 后需手动同步）
                  if (sel.preferences) {
                    await load();
                    const fresh = useSettingsStore.getState().settings;
                    if (fresh) setDraft(structuredClone(fresh));
                  }
                  // 素材/标签变化：刷新素材库列表
                  if (sel.assets || sel.tags) {
                    await useLibraryStore.getState().refresh();
                  }
                }}
              />
            </Group>
          )}

          {route === "about" && (
            <Group title="关于">
              <Field label="版本" hint="茶包素材 BagerTea AiMdeias V2 · 本地素材库">
                <span className="text-sm text-[var(--color-text-secondary)]">v1.0.1（演示构建）</span>
              </Field>
              <Field label="许可证" hint="本项目相关组件许可证">
                <span className="text-xs text-[var(--color-text-secondary)]">本地私有工具 · 部分组件 Apache-2.0 / MIT</span>
              </Field>
              <Field label="数据与日志目录" hint="数据库、缩略图与日志所在目录">
                <div className="flex items-center gap-2">
                  <span className="max-w-52 truncate text-xs text-[var(--color-text-secondary)]" title={dataDir}>
                    {dataDirError ? "暂不可用" : dataDir || "…"}
                  </span>
                  <Button onClick={() => void openDataDir()}>打开文件夹</Button>
                </div>
              </Field>
              <Field label="日志目录" hint="运行日志（保留 7 天）；遇到问题时打包此目录发给支持">
                <Button onClick={() => void openLogsDir()}>打开日志目录</Button>
              </Field>
              <Field label="反馈" hint="功能建议或问题反馈">
                <span className="text-xs text-[var(--color-text-secondary)]">可在素材库问题反馈入口提交</span>
              </Field>
            </Group>
          )}

          {/* 保存按钮统一在最后一项设置之后（sticky 底部，§13 保存栏清晰状态） */}
          <div className="sticky bottom-0 -mx-6 -mb-6 flex flex-wrap items-center gap-3 border-t border-[var(--color-border)] bg-[var(--color-bg)]/95 px-6 py-3 backdrop-blur">
            <Button variant="primary" disabled={saving || !isDirty || !!loadError} onClick={onSave}>
              {saving ? "保存中…" : "保存设置"}
            </Button>
            {isDirty && !saved && (
              <span className="text-xs font-medium text-[var(--color-danger)]">有未保存的更改</span>
            )}
            {saved && !isDirty && <span className="text-xs text-[var(--color-text-secondary)]">已保存</span>}
            {notice && <span className="text-xs text-[var(--color-text-secondary)]">{notice}</span>}
            {error && <span className="text-xs text-[var(--color-danger)]">{error}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

/** §6.2 AI 用途面板：只选择「此功能使用的服务」+ 功能参数，不重复渲染服务管理（§8.7）。 */
function AiPurposePanel({
  usage,
  draft,
  patchAi,
  notify,
  fail,
  onOpenServices,
}: {
  usage: "ai.superSearch" | "ai.tagging";
  draft: Settings;
  patchAi: (patch: Partial<Settings["ai"]>) => void;
  notify: (msg: string) => void;
  fail: (msg: string) => void;
  onOpenServices: () => void;
}) {
  const isSuperSearch = usage === "ai.superSearch";
  const title = isSuperSearch ? "超级搜索" : "自动打标";

  return (
    <Group title={title}>
      <div className="px-4 py-3">
        <p className="text-xs leading-5 text-[var(--color-text-secondary)]">
          {isSuperSearch
            ? "通过在线服务理解搜索意图并匹配素材；素材会按所选服务发送。服务在「服务管理」中维护。"
            : "通过在线服务分析素材并建议标签；素材会按所选服务发送。服务在「服务管理」中维护。"}
        </p>
      </div>

      {/* §8.2 此功能使用的服务：与另一功能可共用或独立选择；修改一个不影响另一个 */}
      <UsageBindingLine
        usage={usage === "ai.superSearch" ? "super_search" : "tagging"}
        notify={notify}
        fail={fail}
      />

      {/* 服务管理入口提示（唯一入口在 AI 设置 → 服务管理，不在此重复渲染列表） */}
      <div className="px-4 py-2">
        <button
          type="button"
          onClick={onOpenServices}
          className="text-xs text-[var(--color-text-secondary)] underline decoration-dotted underline-offset-2 transition-colors hover:text-[var(--color-text)]"
        >
          管理 AI 服务（新增/编辑/测试/删除）
        </button>
      </div>

      {/* W0-6：删「打标时机」死配置（auto_tagging 后端零消费点，选「自动」无任何效果）。
          替代品为 W5g「一键送打标」。 */}
      {!isSuperSearch && (
        <Field label="视频 AI 打标" hint="对视频抽帧后打标（耗时更长）">
          <span className="flex items-center gap-2">
            <Toggle checked={draft.ai.videoTagging} onChange={(v) => patchAi({ videoTagging: v })} />
            <span className="w-16 text-xs whitespace-nowrap text-[var(--color-text-secondary)]">
              {draft.ai.videoTagging ? "已开启" : "未开启"}
            </span>
          </span>
        </Field>
      )}
      {/* FB2-07（§13.6）：视频打标子模式与帧数 —— 仅当视频打标开启时显示，关闭时无意义避免误导 */}
      {!isSuperSearch && draft.ai.videoTagging && (
        <>
          <Field
            label="视频打标模式"
            hint={
              draft.ai.videoTaggingMode === "frames"
                ? "抽多帧分别识别后取多数标签，召回率更高；需要 ffmpeg，每个视频多帧解码"
                : "复用入库封面的低开销 1 次请求；未生成高清封面的视频用第一帧，夜景可能偏暗"
            }
          >
            <select
              value={draft.ai.videoTaggingMode === "frames" ? "frames" : "cover"}
              onChange={(e) => patchAi({ videoTaggingMode: e.target.value as Settings["ai"]["videoTaggingMode"] })}
              className="ui-control rounded-md px-2 py-1.5 text-sm outline-none"
            >
              <option value="cover">封面打标（默认，省开销）</option>
              <option value="frames">抽帧打标（召回率更高）</option>
            </select>
          </Field>
          {draft.ai.videoTaggingMode === "frames" && (
            <Field label="抽帧数" hint="抽帧模式下每个视频抽取的帧数（2–8），越多召回越高、开销越大">
              <TextInput
                type="number"
                value={String(draft.ai.videoFrameCount)}
                onChange={(v) => patchAi({ videoFrameCount: Math.max(2, Math.min(8, Number(v) || 3)) })}
              />
            </Field>
          )}
        </>
      )}
      {/* FB3-07：批大小设置只在云端模式显示（本地模型固定每轮 15 张，设置不生效） */}
      {!isSuperSearch && !draft.ai.profiles.some((p) => p.id === draft.ai.activeProfile && p.kind === "local") && (
        <Field
          label="每批处理数量（云端）"
          hint="一次 AI 任务中云端每轮处理的素材数。不会减少选中的总数：选 120 张、设 20，仍会处理 120 张，只是分 6 轮完成。数字越大速度可能更快，但占用内存和失败重试成本也更高（10–50）"
        >
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={10}
              max={50}
              step={1}
              value={Math.max(10, Math.min(50, draft.ai.batchLimit))}
              onChange={(e) => patchAi({ batchLimit: Math.max(10, Math.min(50, Number(e.target.value) || 30)) })}
              className="ui-range w-40"
              aria-label="每批处理数量"
            />
            <span className="w-10 text-right text-xs tabular-nums text-[var(--color-text-secondary)]">
              {Math.max(10, Math.min(50, draft.ai.batchLimit))}
            </span>
          </div>
        </Field>
      )}
      {!isSuperSearch && draft.ai.profiles.some((p) => p.id === draft.ai.activeProfile && p.kind === "local") && (
        <Field label="每批处理数量" hint="当前为本地模型：固定每轮 15 张，此设置不生效（切换回在线服务后可调）">
          <span className="text-xs text-[var(--color-text-secondary)]">本地固定 15 张/轮</span>
        </Field>
      )}
    </Group>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-xs font-medium tracking-wide text-[var(--color-text-secondary)] uppercase">{title}</h2>
      <div className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
        {children}
      </div>
    </section>
  );
}

/** FB2-01：档位化 slider（0..max 离散档）。只值 0..7，步子固定；拖动即时预览。 */
function RangeSteps({
  value,
  max,
  labelForStep,
  onChange,
}: {
  value: number;
  max: number;
  labelForStep: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="ui-range w-48"
        aria-label="格子大小档位"
      />
      <span className="w-14 shrink-0 text-xs text-[var(--color-text-secondary)]">{labelForStep(value)}</span>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0 sm:max-w-[46%]">
        <p className="text-sm text-[var(--color-text)]">{label}</p>
        {hint && <p className="mt-0.5 text-xs leading-5 text-[var(--color-text-secondary)]">{hint}</p>}
      </div>
      {/* 控件列：窄屏整行、宽屏靠右且可换行，挤压时缩进一行 */}
      <div className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">{children}</div>
    </div>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="ui-control w-52 rounded-md px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
    />
  );
}

function Toggle({
  checked,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`h-5 w-9 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${checked ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]"}`}
    >
      <span
        className={`block h-4 w-4 translate-x-0.5 rounded-full bg-white transition-transform ${checked ? "translate-x-[18px]" : ""}`}
      />
    </button>
  );
}

/** W5c 备份/恢复面板（数据与缓存）：备份 = save 对话框 → backupDb；
 *  恢复 = open 对话框 → 两步强警告确认 → restoreDb（成功后应用自动重启，Promise 不返回）。
 *  运行中任务阻断在 后端命令层（入库/回填/导出/AI 批次）。 */
function BackupRestorePanel({ notify, fail }: { notify: (m: string) => void; fail: (m: string) => void }) {
  const [backing, setBacking] = useState(false);
  const [confirmStep, setConfirmStep] = useState<0 | 1 | 2>(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  const onBackup = async () => {
    const target = await saveDialog({
      title: "备份数据库",
      defaultPath: `library-backup-${new Date().toISOString().slice(0, 10)}.db`,
      filters: [{ name: "SQLite 数据库", extensions: ["db"] }],
    });
    if (!target) return;
    setBacking(true);
    try {
      await backupDb(target);
      notify("备份完成");
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    } finally {
      setBacking(false);
    }
  };

  const onPick = async () => {
    const source = await pickDir({
      title: "选择备份文件",
      multiple: false,
      directory: false,
      filters: [{ name: "SQLite 数据库", extensions: ["db"] }],
    });
    if (!source || Array.isArray(source)) return;
    setPicked(source);
    setConfirmStep(1);
  };

  const onRestore = async () => {
    if (!picked) return;
    setRestoring(true);
    try {
      await restoreDb(picked); // 成功 → 后端 app.restart()，本 Promise 永不 resolve
      notify("恢复完成");
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    } finally {
      setRestoring(false);
      setConfirmStep(0);
      setPicked(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button disabled={backing || restoring} onClick={() => void onBackup()}>
          {backing ? "备份中…" : "备份数据库…"}
        </Button>
        <Button variant="danger" disabled={backing || restoring} onClick={() => void onPick()}>
          从备份恢复…
        </Button>
      </div>
      {confirmStep === 1 && picked && (
        <div className="rounded-md border border-[var(--color-danger)] px-3 py-2 text-xs leading-5">
          <p className="font-medium text-[var(--color-danger)]">
            即将用备份文件覆盖当前素材库：{picked.split(/[\\/]/).pop()}
          </p>
          <p className="mt-1 text-[var(--color-text-secondary)]">
            当前库里「备份之后」新做的入库、打标、收藏评级等改动会全部丢失。有运行中的入库/导出/打标任务时恢复会被拒绝。建议先点「备份数据库」存一份当前状态。
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Button variant="danger" onClick={() => setConfirmStep(2)}>
              我已了解，继续
            </Button>
            <Button
              onClick={() => {
                setConfirmStep(0);
                setPicked(null);
              }}
            >
              取消
            </Button>
          </div>
        </div>
      )}
      {confirmStep === 2 && picked && (
        <div className="rounded-md border border-[var(--color-danger)] px-3 py-2 text-xs leading-5">
          <p className="font-medium text-[var(--color-danger)]">最后确认：恢复后软件会立即自动重启</p>
          <p className="mt-1 text-[var(--color-text-secondary)]">此操作不可撤销（当前库会先存为 library.db.old 保底，但请勿依赖）。</p>
          <div className="mt-2 flex items-center gap-2">
            <Button variant="danger" disabled={restoring} onClick={() => void onRestore()}>
              {restoring ? "恢复中…" : "开始恢复并重启"}
            </Button>
            <Button
              disabled={restoring}
              onClick={() => {
                setConfirmStep(0);
                setPicked(null);
              }}
            >
              取消
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 重置数据面板（数据与缓存）：勾选分类 → 两步确认 → resetAppData。
 *  只清数据库记录与本软件派生缓存，绝不触碰素材原文件。 */
const RESET_ITEMS: { key: keyof ResetDataSelection; label: string; hint: string }[] = [
  { key: "assets", label: "素材库记录", hint: "所有素材记录、搜索索引、导出任务；会同时清掉缩略图/预览/代理缓存文件" },
  { key: "tags", label: "标签与分类", hint: "所有标签、分面结构、别名、打标流水" },
  { key: "aiTasks", label: "AI 打标任务", hint: "打标批次与建议记录" },
  { key: "aiConnections", label: "AI 服务配置", hint: "连接档案、用途绑定，以及系统里保存的 API 密钥" },
  { key: "preferences", label: "偏好设置", hint: "恢复全部默认设置（主题、外观、总库位置、缓存上限等）" },
  { key: "caches", label: "缓存文件", hint: "缩略图/预览/视频代理缓存文件（不影响素材记录）" },
];
const RESET_NONE: ResetDataSelection = {
  assets: false,
  tags: false,
  aiTasks: false,
  aiConnections: false,
  preferences: false,
  caches: false,
};

function ResetDataPanel({
  notify,
  fail,
  onDataReset,
}: {
  notify: (msg: string) => void;
  fail: (msg: string) => void;
  onDataReset: (sel: ResetDataSelection) => Promise<void>;
}) {
  const [sel, setSel] = useState<ResetDataSelection>(RESET_NONE);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const any = Object.values(sel).some(Boolean);

  const onReset = async () => {
    const done = sel;
    setBusy(true);
    setResult(null);
    try {
      const r = await resetAppData(done);
      const parts: string[] = [];
      if (r.assetsDeleted > 0) parts.push(`素材 ${r.assetsDeleted} 条`);
      if (r.tagsDeleted > 0) parts.push(`标签 ${r.tagsDeleted} 条`);
      if (r.aiTasksDeleted > 0) parts.push(`AI 任务记录 ${r.aiTasksDeleted} 条`);
      if (r.connectionsDeleted > 0) parts.push(`AI 服务配置 ${r.connectionsDeleted} 个`);
      if (r.preferencesReset) parts.push("设置已恢复默认");
      if (r.cacheFilesDeleted > 0) parts.push(`缓存文件 ${r.cacheFilesDeleted} 个`);
      const msg = parts.length > 0 ? `重置完成：已清除${parts.join("，")}` : "重置完成：所选数据本来就是空的";
      setResult(msg);
      notify(msg);
      setSel(RESET_NONE);
      setConfirming(false);
      await onDataReset(done);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setResult(msg);
      fail(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div>
        <p className="text-sm text-[var(--color-text)]">重置数据</p>
        <p className="mt-0.5 text-xs leading-5 text-[var(--color-text-secondary)]">
          勾选要清空的数据后点「重置所选数据」。只清软件数据库里的记录和本软件生成的缓存文件，不会删除你的图片、视频原文件
        </p>
      </div>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {RESET_ITEMS.map((item) => (
          <label key={item.key} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1 accent-[var(--color-accent)]"
              checked={sel[item.key]}
              disabled={busy}
              onChange={(e) => {
                setSel((s) => ({ ...s, [item.key]: e.target.checked }));
                setConfirming(false);
              }}
            />
            <span className="min-w-0">
              {item.label}
              <span className="block text-xs leading-4 text-[var(--color-text-secondary)]">{item.hint}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {confirming ? (
          <>
            <span className="text-xs font-medium text-[var(--color-danger)]">
              确认清空所选数据？此操作不可撤销，请先确认没有需要备份的内容
            </span>
            <Button variant="danger" disabled={busy || !any} onClick={() => void onReset()}>
              {busy ? "重置中…" : "确认重置"}
            </Button>
            <Button disabled={busy} onClick={() => setConfirming(false)}>
              取消
            </Button>
          </>
        ) : (
          <Button variant="danger" disabled={busy || !any} onClick={() => setConfirming(true)}>
            重置所选数据
          </Button>
        )}
        {result && <span className="text-xs text-[var(--color-text-secondary)]">{result}</span>}
      </div>
    </div>
  );
}

/** §6.2 用途绑定行：该用途当前绑定哪个连接档案；独立下拉，修改不影响另一用途。
 *  连接档案保存在 ai_connections 表（API Key 走系统凭据）；无绑定 = 回退默认档案。 */
function UsageBindingLine({
  usage,
  notify,
  fail,
}: {
  usage: "super_search" | "tagging";
  notify: (m: string) => void;
  fail: (m: string) => void;
}) {
  const [connections, setConnections] = useState<{ id: string; name: string; hasKey: boolean }[]>([]);
  const [binding, setBinding] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([listAiConnections(), getAiUsageBindings()])
      .then(([conns, binds]) => {
        if (!active) return;
        setConnections(conns);
        setBinding(binds[usage] ?? null);
      })
      .catch(() => {
        /* 非 Tauri / 表未存在：静默降级为「跟随默认档案」 */
      })
      .finally(() => active && setLoaded(true));
    return () => {
      active = false;
    };
  }, [usage]);

  const onSelect = async (connectionId: string) => {
    const next = connectionId === "" ? null : connectionId;
    setSaving(true);
    try {
      await setAiUsageBinding(usage, next);
      setBinding(next);
      notify(next ? "已选择此服务" : "已回退到跟随默认服务");
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) return null;
  return (
    <Field
      label="此功能使用的服务"
      hint="选择后该功能使用此服务；选择「跟随默认服务」则与另一功能共用默认配置"
    >
      <select
        value={binding ?? ""}
        disabled={saving}
        onChange={(e) => void onSelect(e.target.value)}
        className="ui-control rounded-md px-2 py-1.5 text-sm outline-none"
      >
        <option value="">跟随默认服务</option>
        {connections.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}{c.hasKey ? "（已配置密钥）" : "（未配置密钥）"}
          </option>
        ))}
      </select>
    </Field>
  );
}