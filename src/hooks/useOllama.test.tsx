/** W7-2：useOllamaPull 拉取状态机（A2/A3 共用 hook） */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOllamaPull } from "@/hooks/useOllama";
import { onOllamaPullProgress, pullOllamaModel } from "@/api/ollama";

vi.mock("@/api/ollama", () => ({
  onOllamaPullProgress: vi.fn(),
  pullOllamaModel: vi.fn(),
}));

describe("useOllamaPull", () => {
  beforeEach(() => vi.clearAllMocks());

  it("pull 开始时置 busy 与初始进度，完成后复位 busy", async () => {
    vi.mocked(onOllamaPullProgress).mockResolvedValue(() => {});
    vi.mocked(pullOllamaModel).mockResolvedValue(undefined);
    const { result } = renderHook(() => useOllamaPull());
    let promise: Promise<void>;
    act(() => {
      promise = result.current.pull("http://localhost:11434", "qwen2.5vl:7b");
    });
    expect(result.current.pullBusy).toBe(true);
    expect(result.current.pullState?.status).toBe("正在连接…");
    await act(async () => {
      await promise;
    });
    expect(result.current.pullBusy).toBe(false);
    expect(pullOllamaModel).toHaveBeenCalledWith("http://localhost:11434", "qwen2.5vl:7b");
  });

  it("拉取失败也复位 busy（错误由调用方提示）", async () => {
    vi.mocked(onOllamaPullProgress).mockResolvedValue(() => {});
    vi.mocked(pullOllamaModel).mockRejectedValue(new Error("连接失败"));
    const { result } = renderHook(() => useOllamaPull());
    let promise: Promise<void>;
    act(() => {
      promise = result.current.pull("http://x", "m");
    });
    await act(async () => {
      await expect(promise).rejects.toThrow("连接失败");
    });
    expect(result.current.pullBusy).toBe(false);
  });
});
