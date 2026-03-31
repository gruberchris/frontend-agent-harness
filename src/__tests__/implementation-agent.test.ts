import { describe, test, expect, mock } from "bun:test";
import { mkdir } from "node:fs/promises";

let lastChatMessages: Array<{ role: string; content: string }> = [];

// Mock CopilotClient: immediately return mark_task_complete on first call
mock.module("../llm/copilot-client.ts", () => ({
  CopilotClient: class MockCopilotClient {
    constructor(_model: string) {}
    async chat(messages: unknown[]) {
      lastChatMessages = messages as Array<{ role: string; content: string }>;
      return {
        content: null,
        toolCalls: [
          { id: "c1", name: "mark_task_complete", arguments: { summary: "Created index.html" } },
        ],
        usage: { promptTokens: 150, completionTokens: 40, totalTokens: 190 },
        finishReason: "tool_calls" as const,
      };
    }
  },
}));

describe("runImplementationAgent", () => {
  test("executes tool calls and marks task complete", async () => {
    const { runImplementationAgent } = await import("../agents/implementation-agent.ts");
    const tmpPlanFile = `/tmp/impl-agent-plan-${Date.now()}.md`;
    const tmpOutputDir = `/tmp/impl-agent-output-${Date.now()}`;

    await Bun.write(
      tmpPlanFile,
      `### Task 1: Setup scaffold\n**Status**: pending\n**Description**: Init\n**Acceptance Criteria**: Works\n**Example Code**:\n\`\`\`typescript\n// setup\n\`\`\`\n`,
    );

    const task = {
      number: 1,
      title: "Setup scaffold",
      status: "pending" as const,
      description: "Initialize the project",
      acceptanceCriteria: "Project runs",
      exampleCode: "// setup",
      raw: "",
    };

    const result = await runImplementationAgent(
      "gpt-4o",
      task,
      "# Design",
      tmpPlanFile,
      tmpOutputDir,
      undefined,
      "You are a coding implementation agent.",
    );

    expect(result.summary).toBe("Created index.html");
    // Mock returns 190 total tokens. Should NOT be 380 (double-counted).
    expect(result.usage.totalTokens).toBe(190);
    expect(result.usage.promptTokens).toBe(150);
    expect(result.usage.completionTokens).toBe(40);

    // Verify task was marked completed in plan
    const planContent = await Bun.file(tmpPlanFile).text();
    expect(planContent).toContain("**Status**: completed");
  });

  test("injects projectContext into the user message", async () => {
    lastChatMessages = [];
    const { runImplementationAgent } = await import("../agents/implementation-agent.ts");
    const tmpPlanFile = `/tmp/impl-ctx-plan-${Date.now()}.md`;
    const tmpOutputDir = `/tmp/impl-ctx-output-${Date.now()}`;

    await Bun.write(
      tmpPlanFile,
      `### Task 1: Setup scaffold\n**Status**: pending\n**Description**: Init\n**Acceptance Criteria**: Works\n**Example Code**:\n\`\`\`typescript\n// setup\n\`\`\`\n`,
    );

    const task = {
      number: 1,
      title: "Setup scaffold",
      status: "pending" as const,
      description: "Initialize the project",
      acceptanceCriteria: "Project runs",
      exampleCode: "// setup",
      raw: "",
    };

    const injectedContext = "## Tech Stack\n- Framework: React\n\n## Current Output Directory Structure\n(empty — no files yet)";

    await runImplementationAgent(
      "gpt-4o",
      task,
      "# Design",
      tmpPlanFile,
      tmpOutputDir,
      injectedContext,
      "You are a coding implementation agent.",
    );

    const userMsg = lastChatMessages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toContain("Project Context");
    expect(userMsg!.content).toContain("Tech Stack");
    expect(userMsg!.content).toContain("pre-injected");
  });

  test("uses the provided systemPrompt directly", async () => {
    lastChatMessages = [];
    const { runImplementationAgent } = await import("../agents/implementation-agent.ts");
    const tmpPlanFile = `/tmp/impl-sp-plan-${Date.now()}.md`;
    const tmpOutputDir = `/tmp/impl-sp-output-${Date.now()}`;

    await Bun.write(
      tmpPlanFile,
      `### Task 1: Setup scaffold\n**Status**: pending\n**Description**: Init\n**Acceptance Criteria**: Works\n**Example Code**:\n\`\`\`typescript\n// setup\n\`\`\`\n`,
    );

    const task = {
      number: 1,
      title: "Setup scaffold",
      status: "pending" as const,
      description: "Initialize the project",
      acceptanceCriteria: "Project runs",
      exampleCode: "// setup",
      raw: "",
    };

    const customPrompt = "You are a specialist in React applications.";

    await runImplementationAgent(
      "gpt-4o",
      task,
      "# Design",
      tmpPlanFile,
      tmpOutputDir,
      undefined,
      customPrompt,
    );

    const systemMsg = lastChatMessages.find((m) => m.role === "system");
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content).toBe(customPrompt);
  });
});

describe("file operations in output dir", () => {
  test("writes and reads files correctly", async () => {
    const tmpDir = `/tmp/file-ops-${Date.now()}`;
    await mkdir(tmpDir, { recursive: true });

    const testFile = `${tmpDir}/test.txt`;
    await Bun.write(testFile, "hello world");
    const content = await Bun.file(testFile).text();
    expect(content).toBe("hello world");
  });
});
