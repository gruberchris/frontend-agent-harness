import { describe, test, expect, mock, beforeEach } from "bun:test";
import { AzureProvider } from "../../llm/providers/azure-provider.ts";

// Test subclass that injects a mock OpenAI client, avoiding the need to mock
// the openai package globally (which causes export-validation conflicts in Bun
// when multiple test files mock "openai" with different named-export sets).
class TestAzureProvider extends AzureProvider {
  readonly capturedCreateArgs: Record<string, unknown>[] = [];
  private resolvedKey?: string;

  constructor(
    model: string,
    endpoint: string,
    apiVersion: string,
    reasoningEffort?: string,
    maxTokens?: number,
  ) {
    super(model, endpoint, apiVersion, reasoningEffort, maxTokens);
  }

  protected override async initClient(): Promise<void> {
    const bearerToken = process.env["AZURE_OPENAI_BEARER_TOKEN"];
    const apiKey = process.env["AZURE_OPENAI_API_KEY"];
    if (!bearerToken && !apiKey) {
      throw new Error("Either AZURE_OPENAI_BEARER_TOKEN or AZURE_OPENAI_API_KEY must be set for the Azure provider.");
    }
    this.resolvedKey = bearerToken ?? apiKey;
    const self = this;
    // Inject a mock OpenAI-compatible client
    this.client = {
      chat: {
        completions: {
          create: mock(async (args: Record<string, unknown>) => {
            self.capturedCreateArgs.push(args);
            return {
              choices: [
                { message: { content: "Azure response", tool_calls: [] }, finish_reason: "stop" },
              ],
              usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
            };
          }),
        },
      },
    } as never;
  }

  /** Expose whichever credential was resolved (bearer token or api key) */
  get testResolvedKey(): string | undefined { return this.resolvedKey; }
}

describe("AzureProvider", () => {
  beforeEach(() => {
    delete process.env["AZURE_OPENAI_API_KEY"];
    delete process.env["AZURE_OPENAI_BEARER_TOKEN"];
  });

  test("throws when neither AZURE_OPENAI_BEARER_TOKEN nor AZURE_OPENAI_API_KEY is set", async () => {
    const provider = new AzureProvider("gpt-4o", "https://my.openai.azure.com", "2024-06-01");
    await expect(provider.chat([{ role: "user", content: "hi" }])).rejects.toThrow(
      "AZURE_OPENAI_BEARER_TOKEN or AZURE_OPENAI_API_KEY",
    );
  });

  test("reads AZURE_OPENAI_API_KEY from environment (api-key path)", async () => {
    process.env["AZURE_OPENAI_API_KEY"] = "azure-key-123";
    const provider = new TestAzureProvider("gpt-4o", "https://my.openai.azure.com", "2024-06-01");
    await provider.chat([{ role: "user", content: "hi" }]);
    expect(provider.testResolvedKey).toBe("azure-key-123");
  });

  test("reads AZURE_OPENAI_BEARER_TOKEN from environment (bearer path)", async () => {
    process.env["AZURE_OPENAI_BEARER_TOKEN"] = "bearer-token-abc";
    const provider = new TestAzureProvider("gpt-4o", "https://my.openai.azure.com", "2024-06-01");
    await provider.chat([{ role: "user", content: "hi" }]);
    expect(provider.testResolvedKey).toBe("bearer-token-abc");
  });

  test("prefers AZURE_OPENAI_BEARER_TOKEN over AZURE_OPENAI_API_KEY when both are set", async () => {
    process.env["AZURE_OPENAI_BEARER_TOKEN"] = "bearer-token-abc";
    process.env["AZURE_OPENAI_API_KEY"] = "api-key-xyz";
    const provider = new TestAzureProvider("gpt-4o", "https://my.openai.azure.com", "2024-06-01");
    await provider.chat([{ role: "user", content: "hi" }]);
    expect(provider.testResolvedKey).toBe("bearer-token-abc");
  });

  test("sends the correct model in the request", async () => {
    process.env["AZURE_OPENAI_API_KEY"] = "key";
    const provider = new TestAzureProvider("gpt-4-turbo", "https://x.openai.azure.com", "2024-06-01");
    await provider.chat([{ role: "user", content: "hi" }]);
    expect((provider.capturedCreateArgs[0] as { model: string }).model).toBe("gpt-4-turbo");
  });

  test("forwards reasoning_effort when provided", async () => {
    process.env["AZURE_OPENAI_API_KEY"] = "key";
    const provider = new TestAzureProvider("o3", "https://x.openai.azure.com", "2024-06-01", "medium");
    await provider.chat([{ role: "user", content: "hi" }]);
    expect(provider.capturedCreateArgs[0]?.["reasoning_effort"]).toBe("medium");
  });

  test("does not send reasoning_effort when not provided", async () => {
    process.env["AZURE_OPENAI_API_KEY"] = "key";
    const provider = new TestAzureProvider("gpt-4o", "https://x.openai.azure.com", "2024-06-01");
    await provider.chat([{ role: "user", content: "hi" }]);
    expect(provider.capturedCreateArgs[0]?.["reasoning_effort"]).toBeUndefined();
  });

  test("forwards max_completion_tokens (not max_tokens) when provided", async () => {
    process.env["AZURE_OPENAI_API_KEY"] = "key";
    const provider = new TestAzureProvider("gpt-4o", "https://x.openai.azure.com", "2024-06-01", undefined, 1024);
    await provider.chat([{ role: "user", content: "hi" }]);
    expect(provider.capturedCreateArgs[0]?.["max_completion_tokens"]).toBe(1024);
    expect(provider.capturedCreateArgs[0]?.["max_tokens"]).toBeUndefined();
  });

  test("returns parsed LLMResponse with token usage", async () => {
    process.env["AZURE_OPENAI_API_KEY"] = "key";
    const provider = new TestAzureProvider("gpt-4o", "https://x.openai.azure.com", "2024-06-01");
    const response = await provider.chat([{ role: "user", content: "hello" }]);
    expect(response.content).toBe("Azure response");
    expect(response.usage.promptTokens).toBe(20);
    expect(response.usage.completionTokens).toBe(8);
    expect(response.usage.totalTokens).toBe(28);
    expect(response.finishReason).toBe("stop");
  });

  test("reuses client across multiple chat calls (initClient called once)", async () => {
    process.env["AZURE_OPENAI_API_KEY"] = "key";
    const provider = new TestAzureProvider("gpt-4o", "https://x.openai.azure.com", "2024-06-01");
    await provider.chat([{ role: "user", content: "first" }]);
    await provider.chat([{ role: "user", content: "second" }]);
    expect(provider.capturedCreateArgs).toHaveLength(2);
  });

  test("uses bearer auth (OpenAI base client) when AZURE_OPENAI_BEARER_TOKEN is set", async () => {
    const src = await Bun.file(
      new URL("../../llm/providers/azure-provider.ts", import.meta.url).pathname,
    ).text();
    expect(src).toContain("AZURE_OPENAI_BEARER_TOKEN");
    expect(src).toContain("baseURL");
    expect(src).toContain("defaultQuery");
    expect(src).toContain("api-version");
  });

  test("uses api-key auth (AzureOpenAI client) when AZURE_OPENAI_API_KEY is set", async () => {
    const src = await Bun.file(
      new URL("../../llm/providers/azure-provider.ts", import.meta.url).pathname,
    ).text();
    expect(src).toContain("AzureOpenAI");
    expect(src).toContain("AZURE_OPENAI_API_KEY");
    expect(src).toContain("this.endpoint");
    expect(src).toContain("this.apiVersion");
  });
});
