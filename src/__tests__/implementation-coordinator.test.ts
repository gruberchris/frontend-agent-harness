import { describe, test, expect, mock, afterAll } from "bun:test";

// Capture the arguments passed to runImplementationAgent so tests can inspect them
let capturedContextArg: string | undefined;

// Mock CopilotClient so the real implementation agent completes immediately
mock.module("../llm/copilot-client.ts", () => ({
  CopilotClient: class MockCopilotClient {
    constructor(_model: string) {}
    async chat(_messages: unknown[], _tools?: unknown[]) {
      // Capture the first user message to inspect injected context
      const msgs = _messages as Array<{ role: string; content: string }>;
      const userMsg = msgs.find((m) => m.role === "user");
      if (userMsg) capturedContextArg = userMsg.content;
      return {
        content: null,
        toolCalls: [
          { id: "c1", name: "mark_task_complete", arguments: { summary: "Task done" } },
        ],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: "tool_calls",
      };
    }
  },
}));

afterAll(() => mock.restore());

const MULTI_TASK_PLAN = `## Tech Stack
- **Framework**: React 18 + TypeScript
- **Bundler**: Vite
- **Package manager**: Bun

## Project Conventions
- **Entry point**: \`src/main.tsx\`

---

### Task 1: First task
**Status**: pending
**Description**: Do the first thing
**Acceptance Criteria**: First thing done
**Example Code**:
\`\`\`typescript
// task 1
\`\`\`

---

### Task 2: Second task
**Status**: pending
**Description**: Do the second thing
**Acceptance Criteria**: Second thing done
**Example Code**:
\`\`\`typescript
// task 2
\`\`\`
`;

describe("runImplementationCoordinator", () => {
  test("processes all pending tasks and reports count", async () => {
    capturedContextArg = undefined;
    const tmpPlanFile = `/tmp/coord-plan-${Date.now()}.md`;
    const tmpOutputDir = `/tmp/coord-output-${Date.now()}`;
    await Bun.write(tmpPlanFile, MULTI_TASK_PLAN);

    const { runImplementationCoordinator } = await import("../agents/implementation-coordinator.ts");
    const result = await runImplementationCoordinator(
      "gpt-4o",
      "# Design",
      tmpPlanFile,
      tmpOutputDir,
      "You are an implementation coordinator.",
    );

    expect(result.tasksCompleted).toBe(2);
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  });

  test("injects project context into implementation agent", async () => {
    capturedContextArg = undefined;
    const tmpPlanFile = `/tmp/coord-plan-ctx-${Date.now()}.md`;
    const tmpOutputDir = `/tmp/coord-output-ctx-${Date.now()}`;
    await Bun.write(tmpPlanFile, MULTI_TASK_PLAN);

    const { runImplementationCoordinator } = await import("../agents/implementation-coordinator.ts");
    await runImplementationCoordinator("gpt-4o", "# Design", tmpPlanFile, tmpOutputDir, "You are a coordinator.");

    expect(capturedContextArg).toBeDefined();
    expect(capturedContextArg!).toContain("Project Context");
    expect(capturedContextArg!).toContain("Tech Stack");
  });

  test("does not double-count token usage", async () => {
    const tmpPlanFile = `/tmp/coord-plan-tokens-${Date.now()}.md`;
    const tmpOutputDir = `/tmp/coord-output-tokens-${Date.now()}`;
    // single task plan
    const singleTask = MULTI_TASK_PLAN.replace(
      /---\n\n### Task 2[\s\S]*/,
      "",
    );
    await Bun.write(tmpPlanFile, singleTask);

    const { runImplementationCoordinator } = await import("../agents/implementation-coordinator.ts");
    const result = await runImplementationCoordinator(
      "gpt-4o",
      "# Design",
      tmpPlanFile,
      tmpOutputDir,
      "You are a coordinator.",
    );

    // Mock returns 150 total tokens for 1 task. Should NOT be 300 (double-counted).
    expect(result.usage.totalTokens).toBe(150);
    expect(result.usage.promptTokens).toBe(100);
    expect(result.usage.completionTokens).toBe(50);
  });

  test("returns zero tasks when no pending tasks", async () => {
    const allDone = MULTI_TASK_PLAN.replace(/\*\*Status\*\*: pending/g, "**Status**: completed");
    const tmpPlanFile = `/tmp/coord-plan-done-${Date.now()}.md`;
    const tmpOutputDir = `/tmp/coord-output-done-${Date.now()}`;
    await Bun.write(tmpPlanFile, allDone);

    const { runImplementationCoordinator } = await import("../agents/implementation-coordinator.ts");
    const result = await runImplementationCoordinator(
      "gpt-4o",
      "# Design",
      tmpPlanFile,
      tmpOutputDir,
      "You are a coordinator.",
    );

    expect(result.tasksCompleted).toBe(0);
  });
});
