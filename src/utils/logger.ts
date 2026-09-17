/**
 * 前端统一日志入口。
 *
 * 生产环境的 WebView 控制台不可见，因此前端异常和关键状态必须通过原始 invoke
 * 回传到 Rust tracing。这里刻意不调用 src/api/client.ts，避免 invoke 失败 -> logger
 * -> log_frontend 失败 -> logger 的递归。
 */
import { invoke as tauriInvoke } from "@tauri-apps/api/core";

export type LogLevel = "debug" | "info" | "warn" | "error";

const MAX_MESSAGE_CHARS = 4_000;
const MAX_CONTEXT_CHARS = 4_000;
const isDev = import.meta.env?.DEV === true;

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const LOG_SESSION_ID = randomId();
let logSequence = 0;
let correlationSequence = 0;

/** 生成可检索的请求关联标识；同一页面会话内稳定，单次调用唯一。 */
export function createLogCorrelationId(scope: string): string {
  correlationSequence += 1;
  return `${LOG_SESSION_ID}:${scope}:${correlationSequence}`;
}

function truncate(value: string, max = MAX_MESSAGE_CHARS): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

/** 高置信度凭据脱敏；业务调用仍不得主动传入请求体或完整密钥。 */
export function redactLogText(input: string): string {
  return input
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, "Basic <redacted>")
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|authorization)["']?\s*[:=]\s*)(["']?)[^\s,;"'}\]]+/gi,
      "$1$2<redacted>",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "<redacted>");
}

function contextToString(context: unknown): string {
  if (context === undefined || context === null) return "";
  if (typeof context === "string") return truncate(redactLogText(context), MAX_CONTEXT_CHARS);
  try {
    return truncate(redactLogText(JSON.stringify(context)), MAX_CONTEXT_CHARS);
  } catch {
    return "<context not serializable>";
  }
}

function consoleLog(level: LogLevel, message: string, context?: string) {
  if (!isDev) return;
  const args = context === undefined ? [message] : [message, context];
  if (level === "error") console.error(...args);
  else if (level === "warn") console.warn(...args);
  else if (level === "debug") console.debug(...args);
  else console.info(...args);
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function withLogMetadata(context?: unknown): unknown {
  logSequence += 1;
  const metadata = {
    sessionId: LOG_SESSION_ID,
    sequence: logSequence,
  };
  if (typeof context === "string") {
    return { ...metadata, detail: context };
  }
  if (context !== undefined && context !== null && typeof context === "object") {
    // 会话和序号属于日志基础设施字段，业务上下文不得覆盖。
    return { ...context, ...metadata };
  }
  return metadata;
}

function emit(level: LogLevel, message: unknown, context?: unknown) {
  const safeMessage = truncate(redactLogText(String(message)));
  const enrichedContext = withLogMetadata(context);
  const safeContext = contextToString(enrichedContext);
  // 控制台与文件/回传日志使用同一份脱敏后的内容，避免开发环境绕过安全边界。
  consoleLog(level, safeMessage, safeContext || undefined);
  // 日志通道不允许制造新的错误；失败由 Rust stderr 或后续诊断包兜底。
  if (!isTauriRuntime()) return;
  try {
    void tauriInvoke("log_frontend", {
      level,
      message: safeMessage,
      context: safeContext || null,
    }).catch(() => undefined);
  } catch {
    // 非 Tauri 宿主或测试桩不完整时，日志调用同样不得影响业务。
  }
}

export const logger = {
  debug: (message: unknown, context?: unknown) => emit("debug", message, context),
  info: (message: unknown, context?: unknown) => emit("info", message, context),
  warn: (message: unknown, context?: unknown) => emit("warn", message, context),
  error: (message: unknown, context?: unknown) => emit("error", message, context),
};

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ? `${error.message}\n${error.stack}` : error.message;
  }
  return String(error);
}

/** 注册 WebView 全局异常兜底；返回卸载函数，便于测试和热更新。 */
export function installGlobalErrorLogging(target: Window = window): () => void {
  const onError = (event: ErrorEvent) => {
    const location = event.filename
      ? `${event.filename}:${event.lineno}:${event.colno}`
      : "unknown";
    logger.error(`Uncaught error: ${event.message} @ ${location}`, {
      source: "window.error",
      stack: event.error instanceof Error ? event.error.stack : undefined,
    });
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    logger.error(`Unhandled rejection: ${errorDetails(event.reason)}`, {
      source: "window.unhandledrejection",
    });
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onUnhandledRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
}
