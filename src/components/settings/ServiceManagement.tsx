/**
 * ServiceManagement（指导书 §8.2）：AI 服务管理的唯一入口。
 * - 「在线服务 / 本机服务」二选一，只显示当前模式的字段与列表；
 * - 服务实体（名称/地址/模型/密钥/协议）只在这里新增/编辑/删除/测试；
 * - 本机服务 Tab 同时承载引擎向导（Ollama 一键安装/模型管理，改造方案 A3）；
 * - 超级搜索/自动打标页面只选择「此功能使用的服务」，不再重复渲染本面板（§8.7）。
 */
import { useState } from "react";
import clsx from "clsx";
import AiConnectionManager from "@/components/settings/AiConnectionManager";
import LocalModelGroup from "@/components/settings/LocalModelGroup";
import {
  getAiUsageBindings,
  listAiConnections,
  saveAiConnection,
  setAiUsageBinding,
} from "@/api/connections";
import { usePlatformStore, selectManagedOllama } from "@/stores/platformStore";
import type { Settings } from "@/types/settings";

interface Props {
  draft: Settings;
  onPatchAi: (patch: Partial<Settings["ai"]>) => void;
  onPatchSettings: (patch: Partial<Settings>) => void;
  notify: (msg: string) => void;
  fail: (msg: string) => void;
}

const DEFAULT_LOCAL_BASE = "http://localhost:11434/v1";

export default function ServiceManagement({ draft, onPatchAi, onPatchSettings, notify, fail }: Props) {
  // R1（三端复核）：仅 Windows 提供应用管理的本机 Ollama；其余平台只显示在线服务，
  // 引导用户自部署并填写兼容 API 地址。未就绪时保守视为不支持（不猜 Windows）。
  const managedOllama = usePlatformStore(selectManagedOllama);
  const [deployment, setDeployment] = useState<"cloud" | "local">("cloud");
  const [bindVersion, setBindVersion] = useState(0); // 连接变化后刷新列表

  // 非托管平台强制在线服务：即使残留 local 状态也回落 cloud，避免空的本机向导。
  const effectiveDeployment: "cloud" | "local" = managedOllama ? deployment : "cloud";
  const positions = managedOllama ? (["cloud", "local"] as const) : (["cloud"] as const);

  /**
   * Ollama 向导选择模型后同步到实际 AI 连接表。打标/搜索命令读取 ai_connections，
   * 只改 settings.ai.profiles 会导致向导显示成功但实际批次仍使用旧连接。
   */
  const syncLocalModel = async (model: string) => {
    const connections = await listAiConnections();
    const local = connections.find(
      (connection) =>
        connection.deployment === "local" &&
        connection.protocol === "openai_chat" &&
        connection.baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "") ===
          DEFAULT_LOCAL_BASE.replace(/\/v1$/, ""),
    );
    const saved = await saveAiConnection({
      id: local?.id ?? crypto.randomUUID(),
      name: local?.name ?? "本机 Ollama",
      deployment: "local",
      protocol: "openai_chat",
      baseUrl: local?.baseUrl ?? DEFAULT_LOCAL_BASE,
      model,
      apiKey: null,
    });
    const bindings = await getAiUsageBindings();
    const taggingBindingExists = !!bindings.tagging && connections.some((connection) => connection.id === bindings.tagging);
    if (!taggingBindingExists) await setAiUsageBinding("tagging", saved.id);
    setBindVersion((v) => v + 1);
  };

  return (
    <div className="flex flex-col gap-3">
      {/* 服务位置二选一：在线服务 / 本机服务（§3.6 文案：部署方式 → 服务位置） */}
      <div className="flex items-center gap-4 px-4 pt-3">
        <span className="text-xs text-[var(--color-text-secondary)]">服务位置</span>
        <div className="flex items-center gap-1 rounded-md border border-[var(--color-border)] p-0.5">
          {positions.map((d) => (
            <button
              key={d}
              type="button"
              role="tab"
              aria-selected={effectiveDeployment === d}
              onClick={() => setDeployment(d)}
              className={clsx(
                "rounded px-3 py-1 text-sm transition-colors",
                effectiveDeployment === d
                  ? "bg-[var(--color-surface-hover)] font-medium text-[var(--color-text)]"
                  : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]",
              )}
            >
              {d === "cloud" ? "在线服务" : "本机服务"}
            </button>
          ))}
        </div>
      </div>

      <div className="px-4">
        <p className="text-[11px] leading-4 text-[var(--color-text-secondary)]">
          {effectiveDeployment === "cloud"
            ? "通过在线服务分析素材；素材会按所选服务发送。服务配置只在这里维护。"
            : "仅在本机处理，不会上传素材。可安装引擎、下载模型，并管理本机服务。"}
        </p>
      </div>

      {!managedOllama && (
        <div
          role="note"
          className="mx-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
        >
          <p className="text-[11px] leading-4 text-[var(--color-text-secondary)]">
            当前平台暂不支持应用内安装、启动或管理 Ollama。你仍可自行安装兼容服务或连接局域网内的服务，
            再在下方配置地址和模型。
          </p>
        </div>
      )}

      {effectiveDeployment === "local" && (
        <LocalModelGroup
          draft={draft}
          onPatchAi={onPatchAi}
          onPatchSettings={onPatchSettings}
          onModelSelected={syncLocalModel}
          notify={notify}
          fail={fail}
        />
      )}

      <AiConnectionManager
        key={`${effectiveDeployment}-${bindVersion}`}
        deployment={effectiveDeployment}
        notify={notify}
        fail={fail}
        onChanged={() => setBindVersion((v) => v + 1)}
      />
    </div>
  );
}
