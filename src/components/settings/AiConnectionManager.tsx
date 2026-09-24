/**
 * AiConnectionManager（指导书 §6.2/§6.3）：AI 连接档案管理。
 *  - 列出连接档案（含密钥配置状态：已配置/未配置，不回显完整 key）；
 *  - 新增/编辑：名称、接口协议（高级）、服务地址、模型、API 密钥（保存到系统凭据 keyring）；
 *  - 删除（同时清理用途绑定与系统凭据）；
 *  - 编辑凭据：传入新 apiKey 才写 keyring；留空保留原密钥。
 */
import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import Button from "@/components/common/Button";
import ModelCombobox from "@/components/common/ModelCombobox";
import {
  deleteAiConnection,
  discoverAiModels,
  listAiConnections,
  saveAiConnection,
  testAiConnection,
  type AiConnection,
  type AiDeployment,
  type AiProtocol,
} from "@/api/connections";
import { ollamaListLocalModels } from "@/api/ollama";
import { usePlatformStore, selectManagedOllama } from "@/stores/platformStore";

interface Props {
  /** 当前部署模式（在线/本地）：新增连接默认按此部署，列表只显示该部署的连接 */
  deployment: AiDeployment;
  notify: (msg: string) => void;
  fail: (msg: string) => void;
  /** 连接变化后刷新用途绑定列表 */
  onChanged?: () => void;
}

const EMPTY_FORM = {
  name: "",
  deployment: "cloud" as AiDeployment,
  protocol: "openai_chat" as AiProtocol,
  baseUrl: "",
  model: "",
  apiKey: "",
  maxConcurrency: "",
  requestsPerMinute: "",
  requestsPerHour: "",
};

export default function AiConnectionManager({ deployment, notify, fail, onChanged }: Props) {
  const [conns, setConns] = useState<AiConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string | null>>({});
  const [localModels, setLocalModels] = useState<string[] | null>(null);

  // R1（三端复核 X-05）：非托管平台没有「本机服务」tab，从 Windows 迁移来的旧
  // deployment=local 档案必须仍能在在线服务列表里看到/编辑，否则会被过滤丢失。
  const managedOllama = usePlatformStore(selectManagedOllama);
  const visible = conns.filter((c) =>
    deployment === "local" && managedOllama
      ? isManagedOllamaConnection(c, managedOllama)
      : !isManagedOllamaConnection(c, managedOllama),
  );

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const connections = await listAiConnections();
      setConns(connections);
      if (deployment === "local" && managedOllama) {
        try {
          const models = await ollamaListLocalModels("http://localhost:11434/v1");
          setLocalModels(models.map((model) => model.name));
        } catch {
          // 服务未运行时不误标连接；本地服务区会呈现真实运行态。
          setLocalModels(null);
        }
      } else {
        setLocalModels(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [deployment, managedOllama]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const beginEdit = (c: AiConnection) => {
    setEditingId(c.id);
    setForm({
      name: c.name,
      deployment: c.deployment,
      protocol: c.protocol,
      baseUrl: c.baseUrl,
      model: c.model,
      apiKey: "", // 不回显完整 key；留空 = 保留
      maxConcurrency: c.maxConcurrency ? String(c.maxConcurrency) : "",
      requestsPerMinute: c.requestsPerMinute ? String(c.requestsPerMinute) : "",
      requestsPerHour: c.requestsPerHour ? String(c.requestsPerHour) : "",
    });
  };

  const beginAdd = () => {
    setEditingId("__new__");
    setForm({ ...EMPTY_FORM, deployment });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
  };

  const save = async () => {
    if (!form.name.trim()) return fail("请填写服务名称");
    if (!form.baseUrl.trim()) return fail("请填写服务地址");
    const maxConcurrency = parseLimit(form.maxConcurrency, "最大并发数", 128, fail);
    const requestsPerMinute = parseLimit(form.requestsPerMinute, "每分钟请求数", 1_000_000, fail);
    const requestsPerHour = parseLimit(form.requestsPerHour, "每小时请求数", 10_000_000, fail);
    if (maxConcurrency === null || requestsPerMinute === null || requestsPerHour === null) return;
    setSaving(true);
    setError(null);
    try {
      const id = editingId === "__new__" ? crypto.randomUUID() : editingId!;
      await saveAiConnection({
        id,
        name: form.name.trim(),
        deployment: form.deployment,
        protocol: form.protocol,
        baseUrl: form.baseUrl.trim(),
        model: form.model.trim(),
        // 只有用户输入了新 key 才写 keyring；空 = 保留原密钥
        apiKey: form.apiKey.trim() ? form.apiKey.trim() : null,
        maxConcurrency,
        requestsPerMinute,
        requestsPerHour,
      });
      await refresh();
      cancelEdit();
      onChanged?.();
      notify(editingId === "__new__" ? "服务已添加" : "服务已保存");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c: AiConnection) => {
    if (!window.confirm(`删除服务「${c.name}」？将同时清除系统凭据与使用该服务的功能设置。`)) return;
    setError(null);
    try {
      await deleteAiConnection(c.id);
      await refresh();
      onChanged?.();
      notify("服务已删除");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // FB3-08：连接测试走后端（密钥从 keyring 读取；按 OpenAI/Anthropic/本地协议分支测试）。
  // 前端只传 connection_id，不再自己拼 /models 请求——旧实现传空 key 必然 401。
  const test = async (c: AiConnection) => {
    setTestingId(c.id);
    setTestResult((s) => ({ ...s, [c.id]: null }));
    try {
      const r = await testAiConnection(c.id);
      const label = r.ok ? "连接成功" : "连接失败";
      const latency = r.latencyMs > 0 ? `，耗时 ${r.latencyMs}ms` : "";
      setTestResult((s) => ({
        ...s,
        [c.id]: `${label}：${r.message}${latency}`,
      }));
    } catch (e) {
      setTestResult((s) => ({ ...s, [c.id]: `连接失败：${e instanceof Error ? e.message : String(e)}` }));
    } finally {
      setTestingId(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-sm text-[var(--color-text)]">AI 服务</p>
        <Button onClick={beginAdd} disabled={!!editingId}>{editingId ? "请先完成当前编辑" : "+ 新增服务"}</Button>
      </div>
      <p className="text-[11px] leading-4 text-[var(--color-text-secondary)]">
        服务地址、模型和密钥在此统一管理。API 密钥保存在系统凭据中，不会完整显示。
      </p>

      {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}

      {loading ? (
        <p className="text-xs text-[var(--color-text-secondary)]">正在加载服务…</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {visible.map((c) =>
            editingId === c.id ? (
              <li key={c.id} className="flex flex-col gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2">
                    <EditFields form={form} setForm={setForm} connectionId={c.id} managedLocal={deployment === "local" && managedOllama} />
                <div className="flex items-center gap-2">
                  <Button variant="primary" disabled={saving} onClick={() => void save()}>
                    {saving ? "保存中…" : "保存"}
                  </Button>
                  <Button disabled={saving} onClick={cancelEdit}>取消</Button>
                  <span className="text-[10px] text-[var(--color-text-tertiary)]">API 密钥留空时保留原密钥</span>
                </div>
              </li>
            ) : (
              <li key={c.id} className="flex items-center gap-2 rounded-md border border-[var(--color-border)] px-2 py-1.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm text-[var(--color-text)]">{c.name}</span>
                    <span className={clsx("shrink-0 rounded px-1 text-[10px]", c.deployment === "local" ? "bg-[var(--color-surface-hover)]" : "bg-[var(--color-surface-hover)]")}>
                      {c.deployment === "local" ? "本地" : "在线"}
                    </span>
                    <span className="shrink-0 rounded bg-[var(--color-surface-hover)] px-1 text-[10px] text-[var(--color-text-secondary)]">
                      {c.protocol === "anthropic_messages" ? "Anthropic" : "OpenAI 兼容"}
                    </span>
                    {deployment === "local" && localModels && !hasLocalModel(localModels, c.model) && (
                      <span className="shrink-0 rounded bg-[var(--color-status-soft)] px-1 text-[10px] text-[var(--color-status)]">
                        模型未安装
                      </span>
                    )}
                  </div>
                  {deployment !== "local" && (
                    <div className="mt-0.5 text-[10px] text-[var(--color-text-tertiary)]">
                      请求限制：{formatLimit(c.maxConcurrency)} 并发 · {formatLimit(c.requestsPerMinute)} RPM · {formatLimit(c.requestsPerHour)} 次/小时
                    </div>
                  )}
                  <div className="mt-0.5 truncate text-[10px] text-[var(--color-text-secondary)]">
                    {c.baseUrl || "未填地址"} · {c.model || "未选模型"} ·{" "}
                    {c.credentialStatus === "unavailable" ? (
                      <span className="text-[var(--color-danger)]">
                        {c.credentialMessage || "系统密钥服务不可用"}
                      </span>
                    ) : c.credentialStatus === "configured" || (c.credentialStatus == null && c.hasKey) ? (
                      "密钥已配置"
                    ) : (
                      "密钥未配置"
                    )}
                  </div>
                  {testResult[c.id] && (
                    <div className={clsx("text-[10px]", testResult[c.id]?.startsWith("连接失败") ? "text-[var(--color-danger)]" : "text-[var(--color-status)]")}>
                      {testResult[c.id]}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => void test(c)}
                    disabled={testingId === c.id}
                    className="rounded px-1.5 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] disabled:opacity-50"
                  >
                    {testingId === c.id ? "测试中…" : "测试连接"}
                  </button>
                  <button
                    onClick={() => beginEdit(c)}
                    className="rounded px-1.5 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
                  >
                    编辑
                  </button>
                  <button
                    onClick={() => void remove(c)}
                    className="rounded px-1.5 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-red-500"
                  >
                    删除
                  </button>
                </div>
              </li>
            ),
          )}
          {visible.length === 0 && !editingId && (
            <li className="rounded-md border border-dashed border-[var(--color-border)] px-2 py-3 text-center text-xs text-[var(--color-text-secondary)]">
              {deployment === "cloud"
                ? "暂无在线服务，可点击「+ 新增服务」创建。"
                : "暂无本机服务，可点击「+ 新增服务」创建（需本机 Ollama/LM Studio）。"}
            </li>
          )}
          {editingId === "__new__" && (
            <li className="flex flex-col gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2">
              <EditFields form={form} setForm={setForm} connectionId={null} managedLocal={deployment === "local" && managedOllama} />
              <div className="flex items-center gap-2">
                <Button variant="primary" disabled={saving} onClick={() => void save()}>
                  {saving ? "保存中…" : "创建"}
                </Button>
                <Button disabled={saving} onClick={cancelEdit}>取消</Button>
              </div>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function EditFields({
  form,
  setForm,
  connectionId,
  managedLocal,
}: {
  form: typeof EMPTY_FORM;
  setForm: (f: typeof EMPTY_FORM) => void;
  /** FB5-04：编辑中的连接档案 id（__new__ 为 null → legacy 显式字段路径） */
  connectionId: string | null;
  managedLocal: boolean;
}) {
  const inputCls = "ui-control rounded-md px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <label className="w-16 shrink-0 text-xs text-[var(--color-text-secondary)]">服务名称</label>
        <input className={clsx(inputCls, "flex-1")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如「通义官方」" />
      </div>
      <div className="flex items-center gap-2">
        <label className="w-16 shrink-0 text-xs text-[var(--color-text-secondary)]">API 格式（高级）</label>
        <select
          className={clsx(inputCls, "flex-1")}
          value={form.protocol}
          onChange={(e) => setForm({ ...form, protocol: e.target.value as AiProtocol })}
        >
          <option value="openai_chat">OpenAI 兼容（/chat/completions）</option>
          <option value="anthropic_messages">Anthropic Messages（/messages）</option>
        </select>
      </div>
      <div className="flex items-center gap-2">
        <label className="w-16 shrink-0 text-xs text-[var(--color-text-secondary)]">服务地址</label>
        <input className={clsx(inputCls, "flex-1")} value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" />
      </div>
      {!managedLocal && (
        <div className="mt-1 border-t border-[var(--color-border)] pt-2">
          <div className="mb-1 text-xs text-[var(--color-text-secondary)]">请求限制</div>
          <div className="mb-1 text-[10px] leading-4 text-[var(--color-text-tertiary)]">
            用于保护免费或有额度的 API；留空或填 0 表示不限。限制按连接在打标与 AI 搜索间共享。
          </div>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
            <LimitInput label="最大并发数" value={form.maxConcurrency} max={128} onChange={(value) => setForm({ ...form, maxConcurrency: value })} inputCls={inputCls} />
            <LimitInput label="每分钟请求数" value={form.requestsPerMinute} max={1_000_000} onChange={(value) => setForm({ ...form, requestsPerMinute: value })} inputCls={inputCls} />
            <LimitInput label="每小时请求数" value={form.requestsPerHour} max={10_000_000} onChange={(value) => setForm({ ...form, requestsPerHour: value })} inputCls={inputCls} />
          </div>
        </div>
      )}
      {/* FB5-04（§3.6）：模型字段 = 可输入 combobox。草稿 key 优先于 keyring（连接已保存时），
          新连接走 legacy 显式字段路径（无 connectionId）。 */}
      <div className="flex items-center gap-2">
        <label className="w-16 shrink-0 text-xs text-[var(--color-text-secondary)]">模型名称</label>
        <ModelCombobox
          value={form.model}
          onChange={(model) => setForm({ ...form, model })}
          label="模型名称"
          onDiscover={() =>
            discoverAiModels({
              connectionId: connectionId ?? undefined,
              deployment: form.deployment,
              protocol: form.protocol,
              baseUrl: form.baseUrl,
              apiKey: form.apiKey.trim() || undefined,
            })
          }
        />
      </div>
      <div className="flex items-center gap-2">
        <label className="w-16 shrink-0 text-xs text-[var(--color-text-secondary)]">API 密钥</label>
        <input
          type="password"
          className={clsx(inputCls, "flex-1")}
          value={form.apiKey}
          onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
          placeholder="sk-…（留空保留原密钥）"
          autoComplete="new-password"
        />
      </div>
    </div>
  );
}

function LimitInput({
  label,
  value,
  max,
  onChange,
  inputCls,
}: {
  label: string;
  value: string;
  max: number;
  onChange: (value: string) => void;
  inputCls: string;
}) {
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-secondary)]">
      {label}
      <input
        type="number"
        min={0}
        max={max}
        step={1}
        className={clsx(inputCls, "min-w-0 flex-1")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="不限"
        aria-label={label}
      />
    </label>
  );
}

function parseLimit(value: string, label: string, max: number, fail: (message: string) => void): number | null {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  if (!/^\d+$/.test(trimmed)) {
    fail(`${label}必须是非负整数；留空或填 0 表示不限`);
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed > max) {
    fail(`${label}不能超过 ${max}`);
    return null;
  }
  return parsed;
}

function formatLimit(value: number | undefined): string {
  return !value ? "不限" : String(value);
}

function hasLocalModel(models: string[], model: string): boolean {
  return models.some((name) => name === model || name === `${model}:latest` || name.startsWith(`${model}:`));
}

function isManagedOllamaConnection(connection: AiConnection, managedOllama: boolean): boolean {
  if (!managedOllama) return false;
  return (
    connection.deployment === "local" &&
    connection.protocol === "openai_chat" &&
    connection.baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "") === "http://localhost:11434"
  );
}
