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
import type { Settings } from "@/types/settings";

interface Props {
  draft: Settings;
  onPatchAi: (patch: Partial<Settings["ai"]>) => void;
  onPatchSettings: (patch: Partial<Settings>) => void;
  notify: (msg: string) => void;
  fail: (msg: string) => void;
}

export default function ServiceManagement({ draft, onPatchAi, onPatchSettings, notify, fail }: Props) {
  const [deployment, setDeployment] = useState<"cloud" | "local">("cloud");
  const [bindVersion, setBindVersion] = useState(0); // 连接变化后刷新列表

  return (
    <div className="flex flex-col gap-3">
      {/* 服务位置二选一：在线服务 / 本机服务（§3.6 文案：部署方式 → 服务位置） */}
      <div className="flex items-center gap-4 px-4 pt-3">
        <span className="text-xs text-[var(--color-text-secondary)]">服务位置</span>
        <div className="flex items-center gap-1 rounded-md border border-[var(--color-border)] p-0.5">
          {(["cloud", "local"] as const).map((d) => (
            <button
              key={d}
              type="button"
              role="tab"
              aria-selected={deployment === d}
              onClick={() => setDeployment(d)}
              className={clsx(
                "rounded px-3 py-1 text-sm transition-colors",
                deployment === d
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
          {deployment === "cloud"
            ? "通过在线服务分析素材；素材会按所选服务发送。服务配置只在这里维护。"
            : "仅在本机处理，不会上传素材。可一键安装引擎、拉取模型，并管理本机服务。"}
        </p>
      </div>

      {deployment === "local" && (
        <LocalModelGroup
          draft={draft}
          onPatchAi={onPatchAi}
          onPatchSettings={onPatchSettings}
          notify={notify}
          fail={fail}
        />
      )}

      <AiConnectionManager
        key={`${deployment}-${bindVersion}`}
        deployment={deployment}
        notify={notify}
        fail={fail}
        onChanged={() => setBindVersion((v) => v + 1)}
      />
    </div>
  );
}