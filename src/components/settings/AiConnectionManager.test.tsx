/**
 * AiConnectionManager 测试（指导书 §6.3/§12.5）：
 *  - 列出连接档案（名称/部署/协议/密钥配置状态）；
 *  - 新增连接：写 keyring（saveAiConnection 带 apiKey）；错误校验（名称/地址必填）；
 *  - 编辑：留空 apiKey 不覆盖（null 传给后端）；
 *  - 删除：确认后调用 deleteAiConnection（含清理用途绑定）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AiConnectionManager from "@/components/settings/AiConnectionManager";
import { deleteAiConnection, listAiConnections, saveAiConnection } from "@/api/connections";

vi.mock("@/api/connections", () => ({
  listAiConnections: vi.fn(),
  deleteAiConnection: vi.fn(),
  saveAiConnection: vi.fn(),
}));
vi.mock("@/api/ai", () => ({
  aiListModels: vi.fn().mockResolvedValue([]),
}));

import type { AiConnection } from "@/api/connections";

// jsdom 无 crypto.randomUUID 默认实现
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("crypto", { randomUUID: () => "new-conn-1" });
});

const fakeConns: AiConnection[] = [
  { id: "c1", name: "通义", deployment: "cloud", protocol: "openai_chat", baseUrl: "https://a/v1", model: "qwen-max", hasKey: true, enabled: true },
  { id: "c2", name: "本地 Ollama", deployment: "local", protocol: "openai_chat", baseUrl: "http://localhost:11434/v1", model: "llama3.2-vision", hasKey: false, enabled: true },
];

describe("AiConnectionManager（§6.3）", () => {
  it("按部署过滤并列出服务（含密钥状态）", async () => {
    vi.mocked(listAiConnections).mockResolvedValue(fakeConns);
    render(<AiConnectionManager deployment="cloud" notify={vi.fn()} fail={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("通义")).toBeInTheDocument());
    // local 服务被过滤（在线面板不显示本机服务）
    expect(screen.queryByText("本地 Ollama")).not.toBeInTheDocument();
    expect(screen.getByText(/密钥已配置/)).toBeInTheDocument();
  });

  it("标题与按钮使用用户文案「AI 服务 / + 新增服务」而非「连接档案」", async () => {
    vi.mocked(listAiConnections).mockResolvedValue([]);
    render(<AiConnectionManager deployment="cloud" notify={vi.fn()} fail={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("AI 服务")).toBeInTheDocument());
    expect(screen.queryByText("连接档案")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ 新增服务" })).toBeInTheDocument();
  });

  it("新增服务调用 saveAiConnection 并带 apiKey（写系统凭据）", async () => {
    vi.mocked(listAiConnections).mockResolvedValue([]);
    vi.mocked(saveAiConnection).mockResolvedValue({ ...fakeConns[0], id: "new-conn-1" });
    render(<AiConnectionManager deployment="cloud" notify={vi.fn()} fail={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "+ 新增服务" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "+ 新增服务" }));
    fireEvent.change(screen.getByPlaceholderText(/如「通义官方」/), { target: { value: "智谱" } });
    fireEvent.change(screen.getByPlaceholderText(/api.example.com/), { target: { value: "https://zhipu/v1" } });
    fireEvent.change(screen.getByPlaceholderText("qwen-vl-plus"), { target: { value: "glm-4v" } });
    fireEvent.change(screen.getByPlaceholderText(/sk-…/), { target: { value: "sk-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() =>
      expect(saveAiConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "new-conn-1",
          name: "智谱",
          deployment: "cloud",
          baseUrl: "https://zhipu/v1",
          model: "glm-4v",
          apiKey: "sk-secret",
        }),
      ),
    );
  });

  it("编辑留空 API 密钥 → apiKey 传 null（不覆盖原密钥）", async () => {
    vi.mocked(listAiConnections).mockResolvedValue(fakeConns);
    vi.mocked(saveAiConnection).mockResolvedValue(fakeConns[0]);
    render(<AiConnectionManager deployment="cloud" notify={vi.fn()} fail={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("通义")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(saveAiConnection).toHaveBeenCalledWith(expect.objectContaining({ id: "c1", apiKey: null })),
    );
  });

  it("删除需确认并调用 deleteAiConnection", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(listAiConnections).mockResolvedValue(fakeConns);
    vi.mocked(deleteAiConnection).mockResolvedValue(undefined);
    render(<AiConnectionManager deployment="cloud" notify={vi.fn()} fail={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("通义")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "删" }));
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(deleteAiConnection).toHaveBeenCalledWith("c1"));
  });
});