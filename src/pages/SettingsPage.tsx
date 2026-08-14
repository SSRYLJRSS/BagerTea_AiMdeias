/** 设置页（PRD v2.4）：左侧分组导航 + 右侧分组列表；保存按钮在最后一项之后 */
import { useEffect, useState } from "react";
import clsx from "clsx";
import { useShallow } from "zustand/react/shallow";
import { open as pickDir } from "@tauri-apps/plugin-dialog";
import Button from "@/components/common/Button";
import ModelSelect from "@/components/common/ModelSelect";
import { clearThumbnailCache, getDataDir, openDataDir } from "@/api/settings";
import { useSettingsStore } from "@/stores/settingsStore";
import type { ApiProfile, Settings } from "@/types/settings";

type GroupKey = "ai" | "tags" | "library" | "cloud" | "general" | "data";

const GROUPS: { key: GroupKey; label: string }[] = [
  { key: "ai", label: "AI 打标" },
  { key: "tags", label: "标签分类" },
  { key: "library", label: "入库与总库" },
  { key: "cloud", label: "网盘（M2）" },
  { key: "general", label: "通用外观" },
  { key: "data", label: "数据与缓存" },
];

export default function SettingsPage() {
  const { settings, loaded, saving, load, save } = useSettingsStore(
    useShallow((s) => ({ settings: s.settings, loaded: s.loaded, saving: s.saving, load: s.load, save: s.save })),
  );
  const [draft, setDraft] = useState<Settings | null>(null);
  const [group, setGroup] = useState<GroupKey>("ai");
  const [dataDir, setDataDir] = useState("");
  const [editProfileId, setEditProfileId] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  useEffect(() => {
    if (settings && !draft) setDraft(structuredClone(settings));
  }, [settings, draft]);

  useEffect(() => {
    getDataDir().then(setDataDir).catch(() => undefined);
  }, []);

  if (!draft) {
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

  // ---- API 配置档案（多套中转站） ----
  const profiles = draft.ai.profiles;
  const editingProfile =
    profiles.find((p) => p.id === editProfileId) ?? profiles.find((p) => p.id === draft.ai.activeProfile) ?? profiles[0] ?? null;
  const updateProfile = (id: string, patch: Partial<ApiProfile>) =>
    patchAi({ profiles: profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  const addProfile = () => {
    const p: ApiProfile = {
      id: crypto.randomUUID(),
      name: `配置 ${profiles.length + 1}`,
      apiMode: "openai",
      baseUrl: "",
      apiKey: "",
      model: "qwen-vl-plus",
    };
    patchAi({ profiles: [...profiles, p], activeProfile: p.id });
    setEditProfileId(p.id);
  };
  const removeProfile = (id: string) => {
    const rest = profiles.filter((p) => p.id !== id);
    patchAi({ profiles: rest, activeProfile: draft.ai.activeProfile === id ? (rest[0]?.id ?? "") : draft.ai.activeProfile });
    if (editProfileId === id) setEditProfileId(null);
  };

  // ---- 标签分类（PRD 5.5） ----
  const patchCategory = (i: number, patch: Partial<Settings["tagCategories"][number]>) =>
    dirty({ ...draft, tagCategories: draft.tagCategories.map((c, j) => (j === i ? { ...c, ...patch } : c)) });

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
      <aside className="w-[150px] shrink-0 border-r border-[var(--color-border)] p-2">
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
      </aside>

      {/* 右侧分组内容 */}
      <div className="min-w-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto flex max-w-xl flex-col gap-6">
          {group === "ai" && (
            <Group title="AI 打标">
              <Field label="API 配置" hint="可添加多套中转站/服务商，点圆圈切换当前使用的一套">
                <div className="flex flex-col gap-1.5">
                  {draft.ai.profiles.map((p) => (
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
                  <Field label="配置名称" hint="便于区分各中转站，如「通义官方」「中转 A」">
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
                  <Field label="Base URL" hint="云端打标 API 地址">
                    <TextInput value={editingProfile.baseUrl} onChange={(v) => updateProfile(editingProfile.id, { baseUrl: v })} placeholder="https://api.example.com/v1" />
                  </Field>
                  <Field label="API Key" hint="仅存储在本地数据库">
                    <TextInput type="password" value={editingProfile.apiKey} onChange={(v) => updateProfile(editingProfile.id, { apiKey: v })} placeholder="sk-…" />
                  </Field>
                  <Field label="模型" hint="自动从服务商拉取可选模型，也可手动输入">
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
              <Field label="批量上限" hint="单批次最多打标素材数（控制 API 成本）">
                <TextInput
                  type="number"
                  value={String(draft.ai.batchLimit)}
                  onChange={(v) => patchAi({ batchLimit: Math.max(1, Number(v) || 1) })}
                />
              </Field>
            </Group>
          )}

          {group === "tags" && (
            <Group title="标签分类">
              <p className="-mt-2 text-xs text-[var(--color-text-secondary)]">
                分类即素材库里的父标签；AI 会按分类出标签，可自定义增删。hint 会写进 AI 提示词。
              </p>
              {draft.tagCategories.map((c, i) => (
                <div key={i} className="flex items-center gap-2">
                  <TextInput value={c.name} onChange={(v) => patchCategory(i, { name: v })} placeholder="分类名" />
                  <TextInput value={c.hint} onChange={(v) => patchCategory(i, { hint: v })} placeholder="提示词 hint（可选）" />
                  <label className="flex shrink-0 items-center gap-1 text-xs text-[var(--color-text-secondary)]">
                    <input type="checkbox" checked={c.single} onChange={(e) => patchCategory(i, { single: e.target.checked })} />
                    单选
                  </label>
                  <label className="flex shrink-0 items-center gap-1 text-xs text-[var(--color-text-secondary)]" title="每类标签数量上限">
                    上限
                    <input
                      value={c.max || ""}
                      disabled={c.single}
                      onChange={(e) => {
                        const n = parseInt(e.target.value.replace(/\D/g, ""), 10);
                        patchCategory(i, { max: Number.isNaN(n) ? 0 : Math.min(n, 20) });
                      }}
                      inputMode="numeric"
                      className="w-10 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 text-center text-xs outline-none focus:border-[var(--color-accent)] disabled:opacity-40"
                    />
                  </label>
                  <button
                    onClick={() => dirty({ ...draft, tagCategories: draft.tagCategories.filter((_, j) => j !== i) })}
                    className="shrink-0 rounded px-1.5 py-1 text-xs text-[var(--color-text-secondary)] hover:text-red-500"
                  >
                    删
                  </button>
                </div>
              ))}
              <button
                onClick={() => dirty({ ...draft, tagCategories: [...draft.tagCategories, { name: "", hint: "", single: false, max: 3 }] })}
                className="rounded-md border border-dashed border-[var(--color-border)] px-2 py-1.5 text-sm text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text)]"
              >
                + 新增分类
              </button>
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
              <Field label="主题" hint="跟随系统 / 浅色 / 深色">
                <select
                  value={draft.theme}
                  onChange={(e) => dirty({ ...draft, theme: e.target.value as Settings["theme"] })}
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm outline-none"
                >
                  <option value="system">跟随系统</option>
                  <option value="light">浅色</option>
                  <option value="dark">深色</option>
                </select>
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
                    {dataDir || "…"}
                  </span>
                  <Button onClick={() => void openDataDir()}>打开文件夹</Button>
                </div>
              </Field>
              <Field label="清除缓存" hint="手动清除高清缩略图缓存（浏览时会重新生成）">
                <Button onClick={() => void onClearCache()}>立即清除</Button>
              </Field>
              <Field label="关于" hint="茶包素材 BagerTea AiMdeias V2 · 本地素材库">
                <span className="text-sm text-[var(--color-text-secondary)]">v0.1.0</span>
              </Field>
            </Group>
          )}

          {/* 保存按钮统一在最后一项设置之后 */}
          <div className="flex items-center gap-3">
            <Button variant="primary" disabled={saving || !isDirty} onClick={onSave}>
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
