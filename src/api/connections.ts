/** AI 连接档案命令封装（对应 commands/ai_connections_cmd.rs，指导书 §6.3） */
import { invoke } from "./client";

export type AiDeployment = "cloud" | "local";
/** §6.4 协议：apiMode → protocol 迁移后的取值 */
export type AiProtocol = "openai_chat" | "anthropic_messages";

export interface AiConnection {
  id: string;
  name: string;
  deployment: AiDeployment;
  protocol: AiProtocol;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  enabled: boolean;
}

export type AiUsage = "super_search" | "tagging";

export function listAiConnections(): Promise<AiConnection[]> {
  return invoke<AiConnection[]>("list_ai_connections");
}

/** api_key 为 Some(非空) 时写入系统凭据（keyring）；None/空串保留原密钥。 */
export function saveAiConnection(input: {
  id: string;
  name: string;
  deployment: AiDeployment;
  protocol: AiProtocol;
  baseUrl: string;
  model: string;
  apiKey?: string | null;
}): Promise<AiConnection> {
  return invoke<AiConnection>("save_ai_connection", {
    id: input.id,
    name: input.name,
    deployment: input.deployment,
    protocol: input.protocol,
    baseUrl: input.baseUrl,
    model: input.model,
    apiKey: input.apiKey,
  });
}

export function deleteAiConnection(id: string): Promise<void> {
  return invoke<void>("delete_ai_connection", { id });
}

/** 绑定用途 → 连接（null/空 = 解绑，回退默认档案）。修改一个用途不影响另一个（§6.2）。 */
export function setAiUsageBinding(usage: AiUsage, connectionId: string | null): Promise<void> {
  return invoke<void>("set_ai_usage_binding", { usage, connectionId });
}

export function getAiUsageBindings(): Promise<Record<AiUsage, string | null>> {
  return invoke<Record<AiUsage, string | null>>("get_ai_usage_bindings");
}

/** FB3-08：连接测试结果（后端从 keyring 取密钥，按协议分支测试；错误信息已脱敏） */
export interface AiConnectionTestResult {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  protocol: string;
  model: string;
  message: string;
}

/** FB3-08：测试指定连接（密钥只在 Rust 侧读取，前端只传 connection_id） */
export function testAiConnection(connectionId: string): Promise<AiConnectionTestResult> {
  return invoke<AiConnectionTestResult>("test_ai_connection", { connectionId });
}