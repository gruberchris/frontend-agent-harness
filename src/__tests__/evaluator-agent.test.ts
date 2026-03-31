import { describe, test, expect, mock } from "bun:test";

// Mock Playwright MCP server
mock.module("../mcp/playwright-mcp-server.ts", () => ({
  PlaywrightMcpServer: class MockPlaywrightMcpServer {
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

// Mock CopilotClient for PASS scenario
let mockDecision: "pass" | "needs_work" = "pass";

mock.module("../llm/copilot-client.ts", () => ({
  CopilotClient: class MockCopilotClient {
    constructor(_model: string) {}
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
          usage: { promptTokens: 500, completionTokens: 100, totalTokens: 600 },
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
          usage: { promptTokens: 500, completionTokens: 150, totalTokens: 650 },
          finishReason: "tool_calls",
        };
      }
    }
  },
}));

describe("runEvaluatorAgent - PASS", () => {
  test("returns PASS decision with explanation", async () => {
    mockDecision = "pass";
    const { runEvaluatorAgent } = await import("../agents/evaluator-agent.ts");
    const tmpDesignFile = `/tmp/eval-design-${Date.now()}.md`;
    const tmpPlanFile = `/tmp/eval-plan-${Date.now()}.md`;
    await Bun.write(tmpDesignFile, "# App Design\n\nA simple todo app.");

    const result = await runEvaluatorAgent(
      "gpt-4o",
      "http://localhost:3000",
      "# App Design\n\nA simple todo app.",
      tmpPlanFile,
      tmpDesignFile,
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
    await Bun.write(tmpDesignFile, "# App Design\n\nA simple todo app.");

    const result = await runEvaluatorAgent(
      "gpt-4o",
      "http://localhost:3000",
      "# App Design\n\nA simple todo app.",
      tmpPlanFile,
      tmpDesignFile,
      "chrome",
      true,
      "You are an expert UX evaluator.",
    );
    expect(result.explanation).toBe("Header is missing");

    // design.md should have been updated with corrections
    const updatedDesign = await Bun.file(tmpDesignFile).text();
    expect(updatedDesign).toContain("Add a header component");
    expect(updatedDesign).toContain("Evaluator Corrections");
  });
});
