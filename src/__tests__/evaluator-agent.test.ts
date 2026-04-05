import { describe, test, expect, mock, afterEach } from "bun:test";
import * as fs from "node:fs/promises";

const trackedFiles: string[] = [];

afterEach(async () => {
  for (const f of trackedFiles) {
    await fs.rm(f, { force: true, recursive: true }).catch(() => {});
  }
  trackedFiles.length = 0;
});

// Mock Playwright MCP server — captures constructor args for inspection
let capturedMcpOutputDir: string | undefined;

mock.module("../mcp/playwright-mcp-server.ts", () => ({
  PlaywrightMcpServer: class MockPlaywrightMcpServer {
    constructor(_browser: string, _headless: boolean, outputDir?: string) {
      capturedMcpOutputDir = outputDir;
    }
    async start() {
      return [
        {
          name: "browser_navigate",
          description: "Navigate to a URL",
          inputSchema: { type: "object", properties: { url: { type: "string" } } },
        },
        {
          name: "browser_screenshot",
          description: "Take a screenshot",
          inputSchema: { type: "object", properties: {} },
        },
      ];
    }
    async callTool(name: string) {
      if (name === "browser_navigate") {
        return { content: [{ type: "text", text: "Navigated successfully" }] };
      }
      if (name === "browser_screenshot") {
        return { content: [{ type: "text", text: "[screenshot taken]" }] };
      }
      return { content: [{ type: "text", text: "ok" }] };
    }
    async stop() {}
  },
}));

// Mock createLLMClient for PASS scenario
let mockDecision: "pass" | "needs_work" = "pass";

mock.module("../llm/create-client.ts", () => ({
  createLLMClient: () => ({
    async chat() {
      if (mockDecision === "pass") {
        return {
          content: null,
          toolCalls: [
            {
              id: "call_1",
              name: "decide_pass",
              arguments: { explanation: "App matches design perfectly" },
            },
          ],
          usage: { promptTokens: 500, completionTokens: 100, totalTokens: 600, llmCallCount: 1 },
          finishReason: "tool_calls",
        };
      } else {
        return {
          content: null,
          toolCalls: [
            {
              id: "call_1",
              name: "decide_needs_work",
              arguments: {
                explanation: "Header is missing",
                corrections: "Add a header component with the app name",
              },
            },
          ],
          usage: { promptTokens: 500, completionTokens: 150, totalTokens: 650, llmCallCount: 1 },
          finishReason: "tool_calls",
        };
      }
    },
  }),
}));

describe("runEvaluatorAgent - PASS", () => {
  test("returns PASS decision with explanation", async () => {
    mockDecision = "pass";
    const { runEvaluatorAgent } = await import("../agents/evaluator-agent.ts");
    const tmpDesignFile = `/tmp/eval-design-${Date.now()}.md`;
    const tmpPlanFile = `/tmp/eval-plan-${Date.now()}.md`;
    const tmpMemoryFile = `/tmp/eval-memory-${Date.now()}.md`;
    trackedFiles.push(tmpDesignFile, tmpPlanFile, tmpMemoryFile);
    await Bun.write(tmpDesignFile, "# App Design\n\nA simple todo app.");

    const result = await runEvaluatorAgent(
      "gpt-4o",
      { type: "copilot" },
      "http://localhost:3000",
      "# App Design\n\nA simple todo app.",
      tmpPlanFile,
      tmpDesignFile,
      tmpMemoryFile,
      "/tmp/eval-output",
      "chrome",
      true,
      "You are an expert UX evaluator.",
    );
    expect(result.explanation).toBe("App matches design perfectly");
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  });
});

describe("runEvaluatorAgent - NEEDS_WORK", () => {
  test("returns NEEDS_WORK and appends corrections to design.md", async () => {
    mockDecision = "needs_work";
    const { runEvaluatorAgent } = await import("../agents/evaluator-agent.ts");
    const tmpDesignFile = `/tmp/eval-design-${Date.now()}.md`;
    const tmpPlanFile = `/tmp/eval-plan-${Date.now()}.md`;
    const tmpMemoryFile = `/tmp/eval-memory-${Date.now()}.md`;
    trackedFiles.push(tmpDesignFile, tmpPlanFile, tmpMemoryFile);
    await Bun.write(tmpDesignFile, "# App Design\n\nA simple todo app.");

    const result = await runEvaluatorAgent(
      "gpt-4o",
      { type: "copilot" },
      "http://localhost:3000",
      "# App Design\n\nA simple todo app.",
      tmpPlanFile,
      tmpDesignFile,
      tmpMemoryFile,
      "/tmp/eval-output",
      "chrome",
      true,
      "You are an expert UX evaluator.",
    );
    expect(result.explanation).toBe("Header is missing");

    // design.md should NOT have been updated
    const updatedDesign = await Bun.file(tmpDesignFile).text();
    expect(updatedDesign).not.toContain("Add a header component");
    expect(updatedDesign).not.toContain("Evaluator Findings");

    // memory.md should have the corrections
    const updatedMemory = await Bun.file(tmpMemoryFile).text();
    expect(updatedMemory).toContain("Add a header component");
    expect(updatedMemory).toContain("Evaluator Findings");
  });
});

describe("runEvaluatorAgent - outputDir wiring", () => {
  test("passes outputDir to PlaywrightMcpServer constructor", async () => {
    mockDecision = "pass";
    capturedMcpOutputDir = undefined;

    const { runEvaluatorAgent } = await import("../agents/evaluator-agent.ts");
    const tmpDesignFile = `/tmp/eval-design-dir-${Date.now()}.md`;
    const tmpPlanFile = `/tmp/eval-plan-dir-${Date.now()}.md`;
    const tmpMemoryFile = `/tmp/eval-memory-dir-${Date.now()}.md`;
    trackedFiles.push(tmpDesignFile, tmpPlanFile, tmpMemoryFile);
    await Bun.write(tmpDesignFile, "# Design");

    await runEvaluatorAgent(
      "gpt-4o",
      { type: "copilot" },
      "http://localhost:3000",
      "# Design",
      tmpPlanFile,
      tmpDesignFile,
      tmpMemoryFile,
      "/tmp/my-output-dir",
      "chrome",
      true,
      "You are an evaluator.",
    );

    expect(capturedMcpOutputDir).toBeDefined();
    expect(capturedMcpOutputDir!).toBe("/tmp/my-output-dir");
  });
});

describe("runEvaluatorAgent - invalid ref handling", () => {
  test("allows NEEDS_WORK if model recovers from invalid ref and successfully interacts", async () => {
    let callCount = 0;

    mock.module("../llm/create-client.ts", () => ({
      createLLMClient: () => ({
        async chat() {
          callCount++;
          if (callCount === 1) {
            // First call: model tries an invalid ref, then a successful click
            return {
              content: null,
              toolCalls: [
                { id: "call_bad", name: "browser_click", arguments: { ref: "[object Object]" } },
              ],
              usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, llmCallCount: 1 },
              finishReason: "tool_calls",
            };
          }
          if (callCount === 2) {
            // Second call: model corrects itself and clicks with a valid ref
            return {
              content: null,
              toolCalls: [
                { id: "call_good", name: "browser_click", arguments: { ref: "e5" } },
              ],
              usage: { promptTokens: 120, completionTokens: 20, totalTokens: 140, llmCallCount: 1 },
              finishReason: "tool_calls",
            };
          }
          // Third call: model decides NEEDS_WORK (has successfulInteractions > 0)
          return {
            content: null,
            toolCalls: [
              {
                id: "call_nw",
                name: "decide_needs_work",
                arguments: {
                  explanation: "Some features are missing from the implementation",
                  corrections: "Ensure the submit button is present",
                },
              },
            ],
            usage: { promptTokens: 200, completionTokens: 50, totalTokens: 250, llmCallCount: 1 },
            finishReason: "tool_calls",
          };
        },
      }),
    }));

    const { runEvaluatorAgent } = await import("../agents/evaluator-agent.ts");
    const tmpDesignFile = `/tmp/eval-design-blank-${Date.now()}.md`;
    const tmpPlanFile = `/tmp/eval-plan-blank-${Date.now()}.md`;
    const tmpMemoryFile = `/tmp/eval-memory-blank-${Date.now()}.md`;
    trackedFiles.push(tmpDesignFile, tmpPlanFile, tmpMemoryFile);
    await Bun.write(tmpDesignFile, "# App Design\n\nA simple todo app.");

    const result = await runEvaluatorAgent(
      "gpt-4o",
      { type: "copilot" },
      "http://localhost:3000",
      "# App Design\n\nA simple todo app.",
      tmpPlanFile,
      tmpDesignFile,
      tmpMemoryFile,
      "/tmp/eval-blank-output",
      "chrome",
      true,
      "You are an expert UX evaluator.",
    );

    expect(result.decision).toBe("NEEDS_WORK");
    expect(result.explanation).toBeTruthy();
  });

  test("throws EvaluatorModelIncompatibleError when model calls NEEDS_WORK after invalid ref with no successful interactions", async () => {
    let callCount = 0;

    mock.module("../llm/create-client.ts", () => ({
      createLLMClient: () => ({
        async chat() {
          callCount++;
          if (callCount === 1) {
            return {
              content: null,
              toolCalls: [{ id: "call_bad", name: "browser_click", arguments: { ref: "[object Object]" } }],
              usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, llmCallCount: 1 },
              finishReason: "tool_calls",
            };
          }
          // Model immediately gives up and calls NEEDS_WORK without interacting
          return {
            content: null,
            toolCalls: [
              {
                id: "call_nw",
                name: "decide_needs_work",
                arguments: { explanation: "I had technical errors", corrections: "Fix the app" },
              },
            ],
            usage: { promptTokens: 200, completionTokens: 50, totalTokens: 250, llmCallCount: 1 },
            finishReason: "tool_calls",
          };
        },
      }),
    }));

    const { runEvaluatorAgent, EvaluatorModelIncompatibleError } = await import("../agents/evaluator-agent.ts");
    const tmpDesignFile = `/tmp/eval-design-earlyquit-${Date.now()}.md`;
    const tmpPlanFile = `/tmp/eval-plan-earlyquit-${Date.now()}.md`;
    const tmpMemoryFile = `/tmp/eval-memory-earlyquit-${Date.now()}.md`;
    trackedFiles.push(tmpDesignFile, tmpPlanFile, tmpMemoryFile);
    await Bun.write(tmpDesignFile, "# App Design\n\nA simple todo app.");

    await expect(
      runEvaluatorAgent(
        "gemma-4-incompatible",
        { type: "copilot" },
        "http://localhost:3000",
        "# App Design\n\nA simple todo app.",
        tmpPlanFile,
        tmpDesignFile,
        tmpMemoryFile,
        "/tmp/eval-earlyquit-output",
        "chrome",
        true,
        "You are an expert UX evaluator.",
      )
    ).rejects.toThrow(EvaluatorModelIncompatibleError);

    // Restore shared mock
    mock.module("../llm/create-client.ts", () => ({
      createLLMClient: () => ({
        async chat() {
          if (mockDecision === "pass") {
            return {
              content: null,
              toolCalls: [{ id: "call_1", name: "decide_pass", arguments: { explanation: "App matches design perfectly" } }],
              usage: { promptTokens: 500, completionTokens: 100, totalTokens: 600, llmCallCount: 1 },
              finishReason: "tool_calls",
            };
          }
          return {
            content: null,
            toolCalls: [{ id: "call_1", name: "decide_needs_work", arguments: { explanation: "Header is missing", corrections: "Add a header component with the app name" } }],
            usage: { promptTokens: 500, completionTokens: 150, totalTokens: 650, llmCallCount: 1 },
            finishReason: "tool_calls",
          };
        },
      }),
    }));
  });

  test("throws EvaluatorModelIncompatibleError when grace limit is exhausted", async () => {
    mock.module("../llm/create-client.ts", () => ({
      createLLMClient: () => ({
        async chat() {
          // Model always returns [object Object] refs — never corrects itself
          return {
            content: null,
            toolCalls: [
              {
                id: `call_${Date.now()}`,
                name: "browser_click",
                arguments: { ref: "[object Object]" },
              },
            ],
            usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110, llmCallCount: 1 },
            finishReason: "tool_calls",
          };
        },
      }),
    }));

    const { runEvaluatorAgent, EvaluatorModelIncompatibleError } = await import("../agents/evaluator-agent.ts");
    const tmpDesignFile = `/tmp/eval-design-incompat-${Date.now()}.md`;
    const tmpPlanFile = `/tmp/eval-plan-incompat-${Date.now()}.md`;
    const tmpMemoryFile = `/tmp/eval-memory-incompat-${Date.now()}.md`;
    trackedFiles.push(tmpDesignFile, tmpPlanFile, tmpMemoryFile);
    await Bun.write(tmpDesignFile, "# App Design\n\nA simple todo app.");

    await expect(
      runEvaluatorAgent(
        "gemma-4-incompatible",
        { type: "copilot" },
        "http://localhost:3000",
        "# App Design\n\nA simple todo app.",
        tmpPlanFile,
        tmpDesignFile,
        tmpMemoryFile,
        "/tmp/eval-incompat-output",
        "chrome",
        true,
        "You are an expert UX evaluator.",
      )
    ).rejects.toThrow(EvaluatorModelIncompatibleError);

    // Restore the shared mock so subsequent tests work correctly
    mock.module("../llm/create-client.ts", () => ({
      createLLMClient: () => ({
        async chat() {
          if (mockDecision === "pass") {
            return {
              content: null,
              toolCalls: [{ id: "call_1", name: "decide_pass", arguments: { explanation: "App matches design perfectly" } }],
              usage: { promptTokens: 500, completionTokens: 100, totalTokens: 600, llmCallCount: 1 },
              finishReason: "tool_calls",
            };
          }
          return {
            content: null,
            toolCalls: [{ id: "call_1", name: "decide_needs_work", arguments: { explanation: "Header is missing", corrections: "Add a header component with the app name" } }],
            usage: { promptTokens: 500, completionTokens: 150, totalTokens: 650, llmCallCount: 1 },
            finishReason: "tool_calls",
          };
        },
      }),
    }));
  });
});

describe("runEvaluatorAgent - devServerError", () => {
  test("skips Playwright and returns NEEDS_WORK with corrections when dev server is down", async () => {
    mockDecision = "needs_work";
    capturedMcpOutputDir = undefined;

    const { runEvaluatorAgent } = await import("../agents/evaluator-agent.ts");
    const tmpDesignFile = `/tmp/eval-design-dse-${Date.now()}.md`;
    const tmpPlanFile = `/tmp/eval-plan-dse-${Date.now()}.md`;
    const tmpMemoryFile = `/tmp/eval-memory-dse-${Date.now()}.md`;
    trackedFiles.push(tmpDesignFile, tmpPlanFile, tmpMemoryFile);
    await Bun.write(tmpDesignFile, "# Design");

    const devServerError = 'Dev server process exited prematurely (exit code 1).\nStderr:\nerror: Could not resolve: "./src/main.tsx"';

    const result = await runEvaluatorAgent(
      "gpt-4o",
      { type: "copilot" },
      "http://localhost:3000",
      "# Design",
      tmpPlanFile,
      tmpDesignFile,
      tmpMemoryFile,
      "/tmp/eval-dse-output",
      "chrome",
      true,
      "You are an evaluator.",
      undefined,
      undefined,
      devServerError,
    );

    // Should still reach a NEEDS_WORK decision
    expect(result.decision).toBe("NEEDS_WORK");

    // PlaywrightMcpServer constructor should NOT have been called (capturedMcpOutputDir stays undefined)
    // (constructor is not called — playwright is null when devServerError is set)
    expect(capturedMcpOutputDir).toBeUndefined();

    // Corrections should have been written to memory.md
    const memory = await Bun.file(tmpMemoryFile).text();
    expect(memory).toContain("Evaluator Findings");
  });

  test("includes the dev server error text in the initial user message", async () => {
    mockDecision = "needs_work";
    let capturedMessages: Array<{ role: string; content: unknown }> = [];

    mock.module("../llm/create-client.ts", () => ({
      createLLMClient: () => ({
        async chat(messages: unknown[]) {
          capturedMessages = messages as typeof capturedMessages;
          return {
            content: null,
            toolCalls: [{ id: "c1", name: "decide_needs_work", arguments: { explanation: "server down", corrections: "create src/main.tsx" } }],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, llmCallCount: 1 },
            finishReason: "tool_calls" as const,
          };
        },
      }),
    }));

    const { runEvaluatorAgent } = await import("../agents/evaluator-agent.ts");
    const tmpDesignFile = `/tmp/eval-design-msg-${Date.now()}.md`;
    const tmpPlanFile = `/tmp/eval-plan-msg-${Date.now()}.md`;
    const tmpMemoryFile = `/tmp/eval-memory-msg-${Date.now()}.md`;
    trackedFiles.push(tmpDesignFile, tmpPlanFile, tmpMemoryFile);
    await Bun.write(tmpDesignFile, "# Design");

    await runEvaluatorAgent(
      "gpt-4o",
      { type: "copilot" },
      "http://localhost:3000",
      "# Design",
      tmpPlanFile,
      tmpDesignFile,
      tmpMemoryFile,
      "/tmp/eval-msg-output",
      "chrome",
      true,
      "You are an evaluator.",
      undefined,
      undefined,
      "error: Could not resolve: \"./src/main.tsx\"",
    );

    const userMsg = capturedMessages.find((m) => m.role === "user");
    expect(typeof userMsg!.content).toBe("string");
    expect(userMsg!.content as string).toContain("FAILED TO START");
    expect(userMsg!.content as string).toContain("src/main.tsx");
  });
});
