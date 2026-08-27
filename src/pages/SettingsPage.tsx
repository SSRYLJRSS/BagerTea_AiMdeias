/** 设置页（指导书 §2.2/§6.1-§6.7）：
 *  左侧分组导航（含 AI 设置两个子页）+ 右侧分组内容；保存按钮在最后一项之后。
 *  IA：入库与总库 → AI 设置（超级搜索 AI/打标 AI）→ 标签与分类 → 通用外观 → 数据与缓存 → 关于。
 *  AI 子页内使用「在线服务/本地服务」二选一，只渲染当前模式字段。
 */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { useShallow } from "zustand/react/shallow";
import { open as pickDir } from "@tauri-apps/plugin-dialog";
import { on } from "@/api/client";
import Button from "@/components/common/Button";
import { ollamaInstallStatus, ollamaRemoveInstaller } from "@/api/ollama";
import { clearThumbnailCache, getDataDir, openDataDir } from "@/api/settings";
import { rescanAssetMetadata, cancelMediaRefill, type RefillProgress } from "@/api/assets";
import { listAiConnections, getAiUsageBindings, setAiUsageBinding } from "@/api/connections";
import { videoProxyCacheStats, clearAllVideoProxies } from "@/api/video";
import FacetManagePanel from "@/components/settings/FacetManagePanel";
import ServiceManagement from "@/components/settings/ServiceManagement";
import { applyTheme, useSettingsStore } from "@/stores/settingsStore";
import type { Settings } from "@/types/settings";

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

  // ---- AI 分面配置（P1B：facet_key 稳定，single/max 以数据库为准） ----
  const patchFacet = (i: number, patch: Partial<NonNullable<Settings["aiFacetConfigs"]>[number]>) =>
    dirty({ ...draft, aiFacetConfigs: draft.aiFacetConfigs.map((c, j) => (j === i ? { ...c, ...patch } : c)) });

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
      {/* 左侧分组导航 */}
      <aside className="w-[160px] shrink-0 border-r border-[var(--color-border)]">
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

      {/* 右侧分组内容 */}
      <div className="min-w-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto flex max-w-xl flex-col gap-6">
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
              <Field label="分库与改名" hint="入库页可填分库名称（总库下新建子文件夹）并开启批量改名（分库名_序号）">
                <span className="text-xs text-[var(--color-text-secondary)]">在入库页操作</span>
              </Field>
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
                <FacetManagePanel
                  aiConfigs={draft.aiFacetConfigs.map((c) => ({
                    facetKey: c.facetKey,
                    enabledForAi: c.enabledForAi,
                    hint: c.hint,
                    visibleInWorkbench: c.visibleInWorkbench ?? true,
                  }))}
                  onPatchAiConfig={(facetKey, patch) => {
                    const idx = draft.aiFacetConfigs.findIndex((c) => c.facetKey === facetKey);
                    if (idx >= 0) patchFacet(idx, patch);
                  }}
                />
              </div>
            </Group>
          )}

          {route === "general" && (
            <Group title="通用外观">
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
              <Field label="高清缩略图缓存" hint={`上限 ${draft.thumbnailCacheMb} MB，超出后清理最久未用；手动清除后浏览时重新生成`}>
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
                hint="重新读取素材的分辨率/编码/时长/色彩等媒体属性；坏文件记录失败原因，不阻塞批次"
              >
                <div className="flex items-center gap-2">
                  <Button disabled={refilling} onClick={() => void onRefill("missing")}>
                    仅缺字段
                  </Button>
                  <Button disabled={refilling} onClick={() => void onRefill("all")}>
                    全部视频
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
              <Field
                label="视频代理缓存"
                hint={
                  proxyStats && proxyStats.count > 0
                    ? `${proxyStats.count} 个代理文件，约 ${(proxyStats.bytes / 1024 / 1024).toFixed(1)} MB；清理不影响原文件`
                    : "原文件播放不兼容时按需生成 H.264/AAC MP4；暂无可清理的代理（不影响原文件）"
                }
              >
                <Button variant="danger" disabled={clearingProxies} onClick={() => void onClearVideoProxies()}>
                  {clearingProxies ? "清理中…" : "清理全部"}
                </Button>
              </Field>
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
              <Field label="反馈" hint="功能建议或问题反馈">
                <span className="text-xs text-[var(--color-text-secondary)]">可在素材库问题反馈入口提交</span>
              </Field>
            </Group>
          )}

          {/* 保存按钮统一在最后一项设置之后 */}
          <div className="flex items-center gap-3">
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

      <Field label="打标时机" hint="自动：入库即打标；手动：AI 打标页发起（仅打标 AI 生效）">
        <select
          value={draft.ai.autoTagging ? "auto" : "manual"}
          onChange={(e) => patchAi({ autoTagging: e.target.value === "auto" })}
          className="ui-control rounded-md px-2 py-1.5 text-sm outline-none"
        >
          <option value="manual">手动（默认）</option>
          <option value="auto">自动</option>
        </select>
      </Field>
      {!isSuperSearch && (
        <Field label="视频 AI 打标" hint="对视频抽帧后打标（耗时更长）">
          <Toggle checked={draft.ai.videoTagging} onChange={(v) => patchAi({ videoTagging: v })} />
        </Field>
      )}
      {!isSuperSearch && (
        <Field label="执行分块大小" hint="单次请求分块大小：执行层按此内存分块、限流、重试，不截断总批次">
          <TextInput
            type="number"
            value={String(draft.ai.batchLimit)}
            onChange={(v) => patchAi({ batchLimit: Math.max(1, Number(v) || 1) })}
          />
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

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm text-[var(--color-text)]">{label}</p>
        {hint && <p className="text-xs text-[var(--color-text-secondary)]">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
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

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`h-5 w-9 rounded-full transition-colors ${checked ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]"}`}
    >
      <span
        className={`block h-4 w-4 translate-x-0.5 rounded-full bg-white transition-transform ${checked ? "translate-x-[18px]" : ""}`}
      />
    </button>
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