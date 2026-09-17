import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { AppError, invoke } from "@/api/client";
import { logger } from "@/utils/logger";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(tauriInvoke);

describe("api client error contract", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    vi.restoreAllMocks();
  });

  it("preserves backend code and source cause", async () => {
    const logSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    invokeMock.mockRejectedValueOnce({
      code: "IO",
      message: "IO 错误: 文件被占用",
      cause: "Os { code: 32, kind: PermissionDenied, message: \"文件被占用\" }",
    });

    const error = await invoke("open_file").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: "IO",
      message: "IO 错误: 文件被占用",
      cause: "Os { code: 32, kind: PermissionDenied, message: \"文件被占用\" }",
    });
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("invoke failed: open_file [IO]"),
      expect.objectContaining({
        requestId: expect.stringContaining(":open_file:"),
        command: "open_file",
        durationMs: expect.any(Number),
        cause: "Os { code: 32, kind: PermissionDenied, message: \"文件被占用\" }",
      }),
    );
  });
});
