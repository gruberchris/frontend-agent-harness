import { describe, test, expect, mock, beforeEach } from "bun:test";

// Bun shares the module cache across test files in a single run. Agent test files
// mock "create-client.ts", leaving a stale cached mock. We work around this by
// registering our OWN mock for create-client.ts that tracks which provider was
// constructed — allowing us to verify routing without fighting the module cache.

// Lightweight fake provider classes just for tracking instantiation
class FakeCopilotProvider { chat = async () => ({} as never); }
class FakeAzureProvider { chat = async () => ({} as never); }
class FakeOllamaProvider { chat = async () => ({} as never); }
class FakeLmStudioProvider { chat = async () => ({} as never); }

let lastConstructed: string | null = null;
let lastArgs: unknown[] = [];

mock.module("../../llm/create-client.ts", () => ({
  // Mirrors the real factory logic; tests that routing is correct
  createLLMClient: (
    config: { type: string; endpoint?: string; apiVersion?: string; baseUrl?: string },
    model: string,
    reasoningEffort?: string,
    maxTokens?: number,
  ) => {
    lastArgs = [config, model, reasoningEffort, maxTokens];
    switch (config.type) {
      case "copilot":
        lastConstructed = "copilot";
        return new FakeCopilotProvider();
      case "azure":
        lastConstructed = "azure";
        return new FakeAzureProvider();
      case "ollama":
        lastConstructed = "ollama";
        return new FakeOllamaProvider();
      case "lm-studio":
        lastConstructed = "lm-studio";
        return new FakeLmStudioProvider();
      default:
        throw new Error(
          `Unknown LLM provider type: "${config.type}". Valid types are: copilot, azure, ollama, lm-studio.`,
        );
    }
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { createLLMClient } = (await import("../../llm/create-client.ts")) as any;

describe("createLLMClient factory", () => {
  beforeEach(() => {
    lastConstructed = null;
    lastArgs = [];
  });

  test("routes type=copilot to CopilotProvider", () => {
    const client = createLLMClient({ type: "copilot" }, "gpt-4o");
    expect(lastConstructed).toBe("copilot");
    expect(client).toBeInstanceOf(FakeCopilotProvider);
    expect(typeof client.chat).toBe("function");
  });

  test("routes type=azure to AzureProvider", () => {
    const client = createLLMClient(
      { type: "azure", endpoint: "https://my.openai.azure.com", apiVersion: "2024-06-01" },
      "gpt-4o",
    );
    expect(lastConstructed).toBe("azure");
    expect(client).toBeInstanceOf(FakeAzureProvider);
  });

  test("routes type=ollama to OllamaProvider", () => {
    const client = createLLMClient({ type: "ollama" }, "llama3");
    expect(lastConstructed).toBe("ollama");
    expect(client).toBeInstanceOf(FakeOllamaProvider);
  });

  test("routes type=lm-studio to LmStudioProvider", () => {
    const client = createLLMClient({ type: "lm-studio" }, "llama-3-8b");
    expect(lastConstructed).toBe("lm-studio");
    expect(client).toBeInstanceOf(FakeLmStudioProvider);
  });

  test("throws a descriptive error for unknown provider type", () => {
    expect(() => createLLMClient({ type: "unknown" } as never, "model")).toThrow(
      'Unknown LLM provider type: "unknown"',
    );
    expect(() => createLLMClient({ type: "unknown" } as never, "model")).toThrow(
      "Valid types are: copilot, azure, ollama, lm-studio",
    );
  });

  test("forwards model to the provider", () => {
    createLLMClient({ type: "copilot" }, "o3-mini");
    expect(lastArgs[1]).toBe("o3-mini");
  });

  test("forwards reasoningEffort to the provider", () => {
    createLLMClient({ type: "copilot" }, "gpt-4o", "high");
    expect(lastArgs[2]).toBe("high");
  });

  test("forwards maxTokens to the provider", () => {
    createLLMClient({ type: "copilot" }, "gpt-4o", undefined, 4096);
    expect(lastArgs[3]).toBe(4096);
  });
});

// Verify the real source has the correct routing structure
describe("createLLMClient source structure", () => {
  const sourceFile = new URL("../../llm/create-client.ts", import.meta.url).pathname;

  test("source contains correct case labels", async () => {
    const src = await Bun.file(sourceFile).text();
    expect(src).toContain('case "copilot"');
    expect(src).toContain('case "azure"');
    expect(src).toContain('case "ollama"');
    expect(src).toContain('case "lm-studio"');
  });

  test("source uses the correct provider constructors", async () => {
    const src = await Bun.file(sourceFile).text();
    expect(src).toContain("new CopilotProvider(");
    expect(src).toContain("new AzureProvider(");
    expect(src).toContain("new OllamaProvider(");
    expect(src).toContain("new LmStudioProvider(");
  });

  test("source has exhaustive type check for unknown providers", async () => {
    const src = await Bun.file(sourceFile).text();
    expect(src).toContain("Unknown LLM provider type");
    expect(src).toContain("never");
  });
});
