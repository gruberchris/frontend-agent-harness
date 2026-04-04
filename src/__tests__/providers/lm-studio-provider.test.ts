import { describe, test, expect, mock, beforeEach } from "bun:test";

let capturedOpenAIArgs: Record<string, unknown> | undefined;
let capturedCreateArgs: Record<string, unknown> | undefined;

const mockCreate = mock(async (args: unknown) => {
  capturedCreateArgs = args as Record<string, unknown>;
  async function* stream() {
    yield {
      choices: [{ index: 0, delta: { content: "LM Studio response", tool_calls: null }, finish_reason: "stop" }],
      usage: null,
    };
    yield { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } };
  }
  return stream();
});

mock.module("openai", () => {
  const MockOpenAI = function (args: unknown) {
    capturedOpenAIArgs = args as Record<string, unknown>;
    return {
      chat: { completions: { create: mockCreate } },
    };
  };
  MockOpenAI.prototype = {};
  return { default: MockOpenAI };
});

// Clear module cache so the provider re-imports `openai` and picks up the mock above
delete require.cache[require.resolve("../../llm/providers/lm-studio-provider.ts")];
const { LmStudioProvider } = await import("../../llm/providers/lm-studio-provider.ts");

describe("LmStudioProvider", () => {
  beforeEach(() => {
    capturedOpenAIArgs = undefined;
    capturedCreateArgs = undefined;
    mockCreate.mockClear();
  });

  test("defaults to http://localhost:1234 base URL", async () => {
    const provider = new LmStudioProvider("llama-3-8b");
    await provider.chat([{ role: "user", content: "hi" }]);

    expect(capturedOpenAIArgs!["baseURL"]).toBe("http://localhost:1234/v1");
  });

  test("uses custom baseUrl when provided", async () => {
    const provider = new LmStudioProvider("llama-3-8b", "http://10.0.0.5:1234");
    await provider.chat([{ role: "user", content: "hi" }]);

    expect(capturedOpenAIArgs!["baseURL"]).toBe("http://10.0.0.5:1234/v1");
  });

  test("strips trailing slash from baseUrl", async () => {
    const provider = new LmStudioProvider("llama-3-8b", "http://localhost:1234/");
    await provider.chat([{ role: "user", content: "hi" }]);

    expect(capturedOpenAIArgs!["baseURL"]).toBe("http://localhost:1234/v1");
  });

  test("sets apiKey to 'lm-studio' (no real key required)", async () => {
    const provider = new LmStudioProvider("llama-3-8b");
    await provider.chat([{ role: "user", content: "hi" }]);

    expect(capturedOpenAIArgs!["apiKey"]).toBe("lm-studio");
  });

  test("sends the correct model in the request", async () => {
    const provider = new LmStudioProvider("mistral-7b");
    await provider.chat([{ role: "user", content: "hi" }]);

    expect(capturedCreateArgs!["model"]).toBe("mistral-7b");
  });

  test("does NOT forward reasoning_effort (LM Studio ignores it)", async () => {
    // LmStudioProvider ignores reasoningEffort — constructor accepts none
    const provider = new LmStudioProvider("llama-3-8b");
    await provider.chat([{ role: "user", content: "hi" }]);

    expect(capturedCreateArgs!["reasoning_effort"]).toBeUndefined();
  });

  test("forwards max_tokens when provided", async () => {
    const provider = new LmStudioProvider("llama-3-8b", undefined, 4096);
    await provider.chat([{ role: "user", content: "hi" }]);

    expect(capturedCreateArgs!["max_tokens"]).toBe(4096);
  });

  test("returns parsed LLMResponse with token usage", async () => {
    const provider = new LmStudioProvider("llama-3-8b");
    const response = await provider.chat([{ role: "user", content: "hello" }]);

    expect(response.content).toBe("LM Studio response");
    expect(response.toolCalls).toHaveLength(0);
    expect(response.usage.promptTokens).toBe(5);
    expect(response.usage.completionTokens).toBe(3);
    expect(response.usage.totalTokens).toBe(8);
    expect(response.finishReason).toBe("stop");
  });

  test("reuses client across multiple chat calls", async () => {
    const provider = new LmStudioProvider("llama-3-8b");
    await provider.chat([{ role: "user", content: "first" }]);
    await provider.chat([{ role: "user", content: "second" }]);

    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});
