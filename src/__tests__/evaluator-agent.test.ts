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
    const tmpMemoryFile = `/tmp/eval-memory-${Date.now()}.md`;
    trackedFiles.push(tmpDesignFile, tmpPlanFile, tmpMemoryFile);
    await Bun.write(tmpDesignFile, "# App Design\n\nA simple todo app.");

    const result = await runEvaluatorAgent(
      "gpt-4o",
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

    expect(capturedMcpOutputDir).toBe("/tmp/my-output-dir");
  });
});
