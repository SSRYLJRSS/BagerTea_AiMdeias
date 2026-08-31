/**
 * LegacyProfileModelField 测试（FB5-04 §13.5）：
 *  - legacy profile 映射：openai → openai_chat、anthropic → anthropic_messages；
 *  - local/cloud 部署映射正确；通过临时 apiKey 路径加载模型（不伪造 connectionId）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import LegacyProfileModelField, { apiModeToProtocol } from "@/components/common/LegacyProfileModelField";
import { discoverAiModels } from "@/api/connections";

vi.mock("@/api/connections", () => ({
  discoverAiModels: vi.fn(),
}));

const noop = () => undefined;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("LegacyProfileModelField（FB5-04 §13.5）", () => {
  it("apiMode 映射：openai → openai_chat；anthropic → anthropic_messages", () => {
    expect(apiModeToProtocol("openai")).toBe("openai_chat");
    expect(apiModeToProtocol("anthropic")).toBe("anthropic_messages");
  });

  it("cloud + openai：请求带 cloud 部署与 openai_chat 协议，且通过临时 apiKey 路径（不伪造 connectionId）", async () => {
    vi.mocked(discoverAiModels).mockResolvedValue(["qwen-vl-plus"]);
    render(
      <LegacyProfileModelField
        apiMode="openai"
        kind="cloud"
        baseUrl="https://api.example.com/v1"
        apiKey="sk-test"
        model=""
        onModelChange={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "读取模型列表" }));
    await waitFor(() => expect(discoverAiModels).toHaveBeenCalledTimes(1));
    expect(discoverAiModels).toHaveBeenCalledWith({
      deployment: "cloud",
      protocol: "openai_chat",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test",
    });
  });

  it("local + anthropic：deployment=local、protocol=anthropic_messages", async () => {
    vi.mocked(discoverAiModels).mockResolvedValue(["claude-sonnet"]);
    render(
      <LegacyProfileModelField
        apiMode="anthropic"
        kind="local"
        baseUrl="http://localhost:11434/v1"
        apiKey=""
        model=""
        onModelChange={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "读取模型列表" }));
    await waitFor(() => expect(discoverAiModels).toHaveBeenCalledTimes(1));
    expect(discoverAiModels).toHaveBeenCalledWith({
      deployment: "local",
      protocol: "anthropic_messages",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "",
    });
  });
});
