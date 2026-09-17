import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  createLogCorrelationId,
  installGlobalErrorLogging,
  logger,
  redactLogText,
} from "@/utils/logger";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

const invokeMock = vi.mocked(invoke);

describe("frontend logger", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {},
      configurable: true,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("redacts common credentials and bearer tokens", () => {
    const input =
      'apiKey=sk-secret token: abc123 Authorization: Bearer xyz Authorization: Basic dXNlcjpwYXNz';
    const output = redactLogText(input);
    expect(output).not.toContain("sk-secret");
    expect(output).not.toContain("abc123");
    expect(output).not.toContain("xyz");
    expect(output).not.toContain("dXNlcjpwYXNz");
  });

  it("sends structured frontend logs through the raw Tauri invoke", () => {
    logger.error("boom", { command: "list_assets", apiKey: "sk-secret" });
    const calls = invokeMock.mock.calls;
    const payload = calls[calls.length - 1]?.[1];
    expect(payload).toMatchObject({ level: "error", message: "boom" });
    const context = JSON.parse((payload as { context: string }).context);
    expect(context.sessionId).toBeTruthy();
    expect(context.command).toBe("list_assets");
    expect((payload as { context: string }).context).not.toContain("sk-secret");
  });

  it("does not expose the original context in the development console", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logger.error("boom", { apiKey: "sk-console-secret" });

    if (import.meta.env.DEV) {
      expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain("sk-console-secret");
    }
    consoleSpy.mockRestore();
  });

  it("keeps reserved log metadata authoritative over caller context", () => {
    logger.info("reserved fields", {
      sessionId: "caller-controlled",
      sequence: -1,
      command: "get_settings",
    });
    const calls = invokeMock.mock.calls;
    const payload = calls[calls.length - 1]?.[1];
    const context = JSON.parse((payload as { context: string }).context);
    expect(context.sessionId).not.toBe("caller-controlled");
    expect(context.sequence).toBeGreaterThan(0);
    expect(context.command).toBe("get_settings");
  });

  it("creates unique correlation ids within the page session", () => {
    const first = createLogCorrelationId("list_assets");
    const second = createLogCorrelationId("list_assets");
    expect(first).toContain(":list_assets:");
    expect(second).toContain(":list_assets:");
    expect(first).not.toBe(second);
  });

  it("captures window errors and unhandled rejections", async () => {
    const target = new EventTarget() as Window;
    const uninstall = installGlobalErrorLogging(target);
    target.dispatchEvent(
      new ErrorEvent("error", {
        message: "uncaught",
        filename: "app.js",
        lineno: 3,
        colno: 4,
      }),
    );
    const event = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(event, "reason", { value: new Error("rejected") });
    target.dispatchEvent(event);
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledWith(
      "log_frontend",
      expect.objectContaining({ level: "error", message: expect.stringContaining("Uncaught error") }),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "log_frontend",
      expect.objectContaining({ level: "error", message: expect.stringContaining("Unhandled rejection") }),
    );
    uninstall();
  });
});
