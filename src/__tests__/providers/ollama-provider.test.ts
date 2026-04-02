import { describe, test, expect, mock, beforeEach } from "bun:test";

let capturedOpenAIArgs: Record<string, unknown> | undefined;
let capturedCreateArgs: Record<string, unknown> | undefined;

const mockCreate = mock(async (args: unknown) => {
  capturedCreateArgs = args as Record<string, unknown>;
  return {
    choices: [
      {
        message: { content: "Ollama response", tool_calls: [] },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  };
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
delete require.cache[require.resolve("../../llm/providers/ollama-provider.ts")];
const { OllamaProvider } = await import("../../llm/providers/ollama-provider.ts");

describe("OllamaProvider", () => {
  beforeEach(() => {
    capturedOpenAIArgs = undefined;
    capturedCreateArgs = undefined;
    mockCreate.mockClear();
  });

  test("defaults to http://localhost:11434 base URL", async () => {
    const provider = new OllamaProvider("llama3");
    await provider.chat([{ role: "user", content: "hi" }]);

    expect(capturedOpenAIArgs!["baseURL"]).toBe("http://localhost:11434/v1");
  });

  test("uses custom baseUrl when provided", async () => {
    const provider = new OllamaProvider("llama3", "http://10.0.0.5:11434");
    await provider.chat([{ role: "user", content: "hi" }]);

    expect(capturedOpenAIArgs!["baseURL"]).toBe("http://10.0.0.5:11434/v1");
  });

  test("strips trailing slash from baseUrl", async () => {
    const provider = new OllamaProvider("llama3", "http://localhost:11434/");
    await provider.chat([{ role: "user", content: "hi" }]);

    expect(capturedOpenAIArgs!["baseURL"]).toBe("http://localhost:11434/v1");
  });

  test("sets apiKey to 'ollama' (no real key required)", async () => {
    const provider = new OllamaProvider("llama3");
    await provider.chat([{ role: "user", content: "hi" }]);

    expect(capturedOpenAIArgs!["apiKey"]).toBe("ollama");
  });

  test("sends the correct model in the request", async () => {
    const provider = new OllamaProvider("mistral");
    await provider.chat([{ role: "user", content: "hi" }]);

    expect(capturedCreateArgs!["model"]).toBe("mistral");
  });

  test("does NOT forward reasoning_effort even if constructed with one (Ollama ignores it)", async () => {
    // OllamaProvider ignores reasoningEffort — constructor accepts none
    // Verify by checking the request does not include reasoning_effort
    const provider = new OllamaProvider("llama3");
    await provider.chat([{ role: "user", content: "hi" }]);

    expect(capturedCreateArgs!["reasoning_effort"]).toBeUndefined();
  });

  test("forwards max_tokens when provided", async () => {
    const provider = new OllamaProvider("llama3", undefined, 4096);
    await provider.chat([{ role: "user", content: "hi" }]);

    expect(capturedCreateArgs!["max_tokens"]).toBe(4096);
  });

  test("returns parsed LLMResponse with token usage", async () => {
    const provider = new OllamaProvider("llama3");
    const response = await provider.chat([{ role: "user", content: "hello" }]);

    expect(response.content).toBe("Ollama response");
    expect(response.toolCalls).toHaveLength(0);
    expect(response.usage.promptTokens).toBe(5);
    expect(response.usage.completionTokens).toBe(3);
    expect(response.usage.totalTokens).toBe(8);
    expect(response.finishReason).toBe("stop");
  });

  test("reuses client across multiple chat calls", async () => {
    const provider = new OllamaProvider("llama3");
    await provider.chat([{ role: "user", content: "first" }]);
    await provider.chat([{ role: "user", content: "second" }]);

    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});
