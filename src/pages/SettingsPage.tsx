/** 设置页（PRD v2.4）：左侧分组导航 + 右侧分组列表；保存按钮在最后一项之后 */
import { useEffect, useState } from "react";
import clsx from "clsx";
import { useShallow } from "zustand/react/shallow";
import { open as pickDir } from "@tauri-apps/plugin-dialog";
import Button from "@/components/common/Button";
import ModelSelect from "@/components/common/ModelSelect";
import { ollamaInstallStatus, ollamaRemoveInstaller } from "@/api/ollama";
import { clearThumbnailCache, getDataDir, openDataDir } from "@/api/settings";
import LocalModelGroup from "@/components/settings/LocalModelGroup";
import TagManageDialog from "@/components/dialogs/TagManageDialog";
import { applyTheme, useSettingsStore } from "@/stores/settingsStore";
import { WORKBENCH_DEFAULT_KEYS } from "@/stores/tagStore";
import type { ApiProfile, Settings } from "@/types/settings";

type GroupKey = "ai" | "local" | "tags" | "library" | "cloud" | "general" | "data";

const GROUPS: { key: GroupKey; label: string }[] = [
  { key: "ai", label: "在线打标" },
  { key: "local", label: "本地打标" },
  { key: "tags", label: "标签分类" },
  { key: "library", label: "入库与总库" },
  { key: "cloud", label: "网盘（M2）" },
  { key: "general", label: "通用外观" },
  { key: "data", label: "数据与缓存" },
];

export default function SettingsPage({ onBack }: { onBack?: () => void }) {
  const { settings, loaded, saving, load, save, loadError } = useSettingsStore(
    useShallow((s) => ({
      settings: s.settings,
      loaded: s.loaded,
      saving: s.saving,
      load: s.load,
      save: s.save,
      loadError: s.loadError,
    })),
  );
  const [draft, setDraft] = useState<Settings | null>(null);
  const [group, setGroup] = useState<GroupKey>("ai");
  const [dataDir, setDataDir] = useState("");
  const [dataDirError, setDataDirError] = useState(false);
  const [editProfileId, setEditProfileId] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A3：安装包缓存（「数据与缓存」分组展示占用/清理）
  const [installerInfo, setInstallerInfo] = useState<{ path: string; size: number } | null>(null);
  const [removingInstaller, setRemovingInstaller] = useState(false);

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

  // 进入「数据与缓存」分组时刷新安装包缓存信息
  useEffect(() => {
    if (group !== "data") return;
    ollamaInstallStatus()
      .then((s) =>
        s.installerPath ? setInstallerInfo({ path: s.installerPath, size: s.installerSize }) : setInstallerInfo(null),
      )
      .catch(() => setInstallerInfo(null));
  }, [group]);

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
    // P2-03：加载失败不能永久停留在「加载设置中…」——给出错误与重试入口；
    // 且 settings 未加载时表单根本不渲染，天然杜绝「在默认设置上保存覆盖真实配置」
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
        加载设置中…
      </div>
    );
  }

  const dirty = (next: Settings) => {
    setDraft(next);
    setSaved(false);
  };
  /** 与已保存值对比（防止「选了总库但忘保存」类事故） */
  const isDirty = !!settings && JSON.stringify(draft) !== JSON.stringify(settings);
  const patchAi = (patch: Partial<Settings["ai"]>) => dirty({ ...draft, ai: { ...draft.ai, ...patch } });

  // ---- API 配置档案（在线打标：仅云端服务商/中转站；本地档案由「本地打标」分组管理） ----
  const profiles = draft.ai.profiles.filter((p) => (p.kind ?? "cloud") !== "local");
  const editingProfile =
    profiles.find((p) => p.id === editProfileId) ?? profiles.find((p) => p.id === draft.ai.activeProfile) ?? profiles[0] ?? null;
  const updateProfile = (id: string, patch: Partial<ApiProfile>) =>
    patchAi({ profiles: draft.ai.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  const addProfile = () => {
    const p: ApiProfile = {
      id: crypto.randomUUID(),
      name: `配置 ${profiles.length + 1}`,
      apiMode: "openai",
      kind: "cloud",
      baseUrl: "",
      apiKey: "",
      model: "qwen-vl-plus",
    };
    patchAi({ profiles: [...draft.ai.profiles, p], activeProfile: p.id });
    setEditProfileId(p.id);
  };
  const removeProfile = (id: string) => {
    const rest = draft.ai.profiles.filter((p) => p.id !== id);
    patchAi({ profiles: rest, activeProfile: draft.ai.activeProfile === id ? (rest[0]?.id ?? "") : draft.ai.activeProfile });
    if (editProfileId === id) setEditProfileId(null);
  };

  // ---- AI 分面配置（P1B：facet_key 稳定，single/max 以数据库为准） ----
  const patchFacet = (i: number, patch: Partial<NonNullable<Settings["aiFacetConfigs"]>[number]>) =>
    dirty({ ...draft, aiFacetConfigs: draft.aiFacetConfigs.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const [manageOpen, setManageOpen] = useState(false);

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

  return (
    <div className="flex h-full">
      {/* 左侧分组导航 */}
      <aside className="w-[150px] shrink-0 border-r border-[var(--color-border)]">
        {onBack && (
          <button
            onClick={onBack}
            className="w-full border-b border-[var(--color-border)] px-3 py-2 text-left text-sm text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
          >
            ← 返回
          </button>
        )}
        <div className="p-2">
          {GROUPS.map((g) => (
            <button
              key={g.key}
              onClick={() => setGroup(g.key)}
              className={clsx(
                "block w-full rounded px-2 py-1.5 text-left text-sm transition-colors",
                group === g.key
                  ? "bg-[var(--color-surface)] font-medium text-[var(--color-text)]"
                  : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]",
              )}
            >
              {g.label}
            </button>
          ))}
        </div>
      </aside>

      {/* 右侧分组内容 */}
      <div className="min-w-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto flex max-w-xl flex-col gap-6">
          {group === "ai" && (
            <Group title="在线打标">
              <p className="-mt-2 text-xs text-[var(--color-text-secondary)]">
                使用云端 API（中转站/服务商，如通义、智谱）识别素材；需要本地离线免费打标请到「本地打标」分组配置。
              </p>
              <Field label="API 配置" hint="可添加多套中转站/服务商，点圆圈切换当前使用的一套">
                <div className="flex flex-col gap-1.5">
                  {profiles.map((p) => (
                    <div key={p.id} className="flex items-center gap-2">
                      <button
                        onClick={() => patchAi({ activeProfile: p.id })}
                        title="设为当前使用"
                        className={clsx(
                          "h-3.5 w-3.5 shrink-0 rounded-full border transition-colors",
                          draft.ai.activeProfile === p.id
                            ? "border-[var(--color-accent)] bg-[var(--color-accent)]"
                            : "border-[var(--color-border)] hover:border-[var(--color-text-secondary)]",
                        )}
                      />
                      <button
                        onClick={() => setEditProfileId(p.id)}
                        className={clsx(
                          "min-w-0 flex-1 truncate rounded-md border px-2 py-1.5 text-left text-sm transition-colors",
                          editingProfile?.id === p.id
                            ? "border-[var(--color-accent)] text-[var(--color-text)]"
                            : "border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]",
                        )}
                      >
                        {p.name || "未命名"}
                        {draft.ai.activeProfile === p.id && <span className="ml-1.5 text-xs">· 当前</span>}
                      </button>
                      <button
                        onClick={() => removeProfile(p.id)}
                        className="shrink-0 rounded px-1.5 py-1 text-xs text-[var(--color-text-secondary)] hover:text-red-500"
                      >
                        删
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={addProfile}
                    className="rounded-md border border-dashed border-[var(--color-border)] px-2 py-1.5 text-sm text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text)]"
                  >
                    + 新增配置
                  </button>
                </div>
              </Field>

              {editingProfile && (
                <>
                  <Field label="配置名称" hint="便于区分各中转站，如「通义官方」「智谱官方」">
                    <TextInput value={editingProfile.name} onChange={(v) => updateProfile(editingProfile.id, { name: v })} placeholder="中转站 A" />
                  </Field>
                  <Field label="API Mode" hint="接口协议格式，需与服务商匹配">
                    <select
                      value={editingProfile.apiMode}
                      onChange={(e) => updateProfile(editingProfile.id, { apiMode: e.target.value as ApiProfile["apiMode"] })}
                      className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm outline-none"
                    >
                      <option value="openai">OpenAI 兼容（/chat/completions）</option>
                      <option value="anthropic">Anthropic Messages（/messages）</option>
                    </select>
                  </Field>
                  <Field label="Base URL" hint="云端打标 API 地址（中转站/服务商）">
                    <TextInput
                      value={editingProfile.baseUrl}
                      onChange={(v) => updateProfile(editingProfile.id, { baseUrl: v })}
                      placeholder="https://api.example.com/v1"
                    />
                  </Field>
                  <Field label="API Key" hint="仅存储在本地数据库">
                    <TextInput type="password" value={editingProfile.apiKey} onChange={(v) => updateProfile(editingProfile.id, { apiKey: v })} placeholder="sk-…" />
                  </Field>
                  <Field
                    label="模型"
                    hint="自动从服务商拉取可选模型，也可手动输入"
                  >
                    <ModelSelect apiMode={editingProfile.apiMode} baseUrl={editingProfile.baseUrl} apiKey={editingProfile.apiKey} value={editingProfile.model} onChange={(v) => updateProfile(editingProfile.id, { model: v })} />
                  </Field>
                </>
              )}
              <Field label="打标时机" hint="自动：入库即打标；手动：AI 打标页发起">
                <select
                  value={draft.ai.autoTagging ? "auto" : "manual"}
                  onChange={(e) => patchAi({ autoTagging: e.target.value === "auto" })}
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm outline-none"
                >
                  <option value="manual">手动（默认）</option>
                  <option value="auto">自动</option>
                </select>
              </Field>
              <Field label="视频 AI 打标" hint="对视频抽帧后打标（耗时更长）">
                <Toggle checked={draft.ai.videoTagging} onChange={(v) => patchAi({ videoTagging: v })} />
              </Field>
              <Field label="执行分块大小" hint="单次请求分块大小：执行层按此内存分块、限流、重试，不截断总批次">
                <TextInput
                  type="number"
                  value={String(draft.ai.batchLimit)}
                  onChange={(v) => patchAi({ batchLimit: Math.max(1, Number(v) || 1) })}
                />
              </Field>
            </Group>
          )}

          {group === "local" && (
            <Group title="本地打标">
              <p className="-mt-2 text-xs text-[var(--color-text-secondary)]">
                使用本机 Ollama/LM Studio 视觉模型离线打标，免费且不联网。可一键安装引擎、拉取模型，并管理已下载的模型（删除释放磁盘空间）。
              </p>
              <LocalModelGroup
                draft={draft}
                onPatchAi={patchAi}
                onPatchSettings={(patch) => dirty({ ...draft, ...patch })}
                notify={(m) => setNotice(m)}
                fail={(m) => setError(m)}
              />
            </Group>
          )}

          {group === "tags" && (
            <Group title="AI 分面">
              <p className="-mt-2 text-xs text-[var(--color-text-secondary)]">
                分面 key 稳定不可修改；AI 打标与 AI 搜索共用此配置。显示名可本地化，单选/上限由数据库决定。
              </p>
              <p className="-mt-1 mb-1 text-[11px] text-[var(--color-text-secondary)]">
                两个开关语义独立：「AI」= 是否参与 AI 打标/搜索提示词；「工作台」= 是否显示在人工打标面板。
              </p>
              {draft.aiFacetConfigs.map((c, i) => (
                <div key={c.facetKey} className="flex items-center gap-2">
                  <span className="w-28 shrink-0 truncate rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text)]" title={c.facetKey}>
                    {c.facetKey}
                  </span>
                  <TextInput value={c.hint} onChange={(v) => patchFacet(i, { hint: v })} placeholder="提示词 hint（可选）" />
                  <TextInput value={c.displayName ?? ""} onChange={(v) => patchFacet(i, { displayName: v || undefined })} placeholder="显示名（可选）" />
                  <label className="flex shrink-0 items-center gap-1 text-xs text-[var(--color-text-secondary)]" title="是否参与 AI 打标与搜索提示词">
                    <input type="checkbox" checked={c.enabledForAi} onChange={(e) => patchFacet(i, { enabledForAi: e.target.checked })} />
                    AI
                  </label>
                  <label className="flex shrink-0 items-center gap-1 text-xs text-[var(--color-text-secondary)]" title="是否显示在人工打标工作台">
                    <input
                      type="checkbox"
                      checked={c.visibleInWorkbench ?? (WORKBENCH_DEFAULT_KEYS as readonly string[]).includes(c.facetKey)}
                      onChange={(e) => patchFacet(i, { visibleInWorkbench: e.target.checked })}
                    />
                    工作台
                  </label>
                </div>
              ))}

              {/* §9.6 标签治理：搜索/新建/重命名/移动/合并/加别名/停用/影响范围（复用现有 TagManageDialog + 治理命令） */}
              <div className="mt-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                <h4 className="mb-1 text-xs font-medium text-[var(--color-text)]">标签治理</h4>
                <p className="mb-2 text-[11px] leading-4 text-[var(--color-text-secondary)]">
                  搜索、新建、重命名、移动、合并、添加别名、停用标签，并查看影响范围。
                </p>
                <Button className="w-full" onClick={() => setManageOpen(true)}>
                  打开标签管理
                </Button>
              </div>
            </Group>
          )}

          {group === "library" && (
            <Group title="入库与总库">
              <Field label="总库位置" hint="配置后，入库将把文件复制到 总库/分库/ 下统一管理；留空 = 原位索引">
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    value={draft.libraryRoot}
                    placeholder="未配置"
                    className="w-52 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm outline-none"
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

          {group === "cloud" && (
            <Group title="网盘（二期开放 M2）">
              <Field label="百度网盘" hint="官方 OAuth 授权绑定">
                <Button disabled>绑定（M2 开放）</Button>
              </Field>
              <Field label="夸克网盘（实验性）" hint="cookie 绑定，接口可能变更">
                <Button disabled>绑定（M2 开放）</Button>
              </Field>
            </Group>
          )}

          {group === "general" && (
            <Group title="通用外观">
              <Field label="主题" hint="跟随系统 / 浅色 / 深色；切换即时预览，保存后记住">
                <select
                  value={draft.theme}
                  onChange={(e) => {
                    const t = e.target.value as Settings["theme"];
                    applyTheme(t); // R-24：即时预览，不等保存
                    dirty({ ...draft, theme: t });
                  }}
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm outline-none"
                >
                  <option value="system">跟随系统</option>
                  <option value="light">浅色</option>
                  <option value="dark">深色</option>
                </select>
              </Field>
              <Field label="回收站保留天数" hint="超期后启动时自动彻底清理；0 = 不自动清理">
                <TextInput
                  type="number"
                  value={String(draft.trashRetentionDays)}
                  onChange={(v) => dirty({ ...draft, trashRetentionDays: Math.max(0, Number(v) || 0) })}
                />
              </Field>
              <Field label="高清缩略图缓存上限" hint="单位 MB，超出后清理最久未用">
                <TextInput
                  type="number"
                  value={String(draft.thumbnailCacheMb)}
                  onChange={(v) => dirty({ ...draft, thumbnailCacheMb: Math.max(0, Number(v) || 0) })}
                />
              </Field>
            </Group>
          )}

          {group === "data" && (
            <Group title="数据与缓存">
              <Field label="软件数据保存位置" hint="数据库与缩略图所在目录，备份/转移素材库时复制此目录">
                <div className="flex items-center gap-2">
                  <span className="max-w-52 truncate text-xs text-[var(--color-text-secondary)]" title={dataDir}>
                    {dataDirError ? "暂不可用" : dataDir || "…"}
                  </span>
                  <Button onClick={() => void openDataDir()}>打开文件夹</Button>
                </div>
              </Field>
              <Field label="清除缓存" hint="手动清除高清缩略图缓存（浏览时会重新生成）">
                <Button onClick={() => void onClearCache()}>立即清除</Button>
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
              <Field label="关于" hint="茶包素材 BagerTea AiMdeias V2 · 本地素材库">
                <span className="text-sm text-[var(--color-text-secondary)]">v0.1.0</span>
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

      {/* §9.6 标签治理入口：搜索/新建/重命名/移动/合并/加别名/停用/影响范围 */}
      <TagManageDialog open={manageOpen} onClose={() => setManageOpen(false)} />
    </div>
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
      className="w-52 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
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
