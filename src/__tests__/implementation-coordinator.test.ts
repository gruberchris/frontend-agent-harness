import { describe, test, expect, mock, afterAll, afterEach } from "bun:test";
import * as fs from "node:fs/promises";

// Capture the arguments passed to runImplementationAgent so tests can inspect them
let capturedContextArg: string | undefined;
let coordMockCallCount = 0;
const trackedFiles: string[] = [];

afterEach(async () => {
  for (const f of trackedFiles) {
    await fs.rm(f, { force: true, recursive: true }).catch(() => {});
  }
  trackedFiles.length = 0;
});

// Mock CopilotClient so the real implementation agent completes:
// odd-numbered calls write a file; even-numbered calls mark complete
mock.module("../llm/copilot-client.ts", () => ({
  CopilotClient: class MockCopilotClient {
    constructor(_model: string) {}
    async chat(_messages: unknown[], _tools?: unknown[]) {
      // Capture the first user message to inspect injected context
      const msgs = _messages as Array<{ role: string; content: string }>;
      const userMsg = msgs.find((m) => m.role === "user");
      if (userMsg) capturedContextArg = userMsg.content;
      coordMockCallCount++;
      if (coordMockCallCount % 2 === 1) {
        // Write a file first so the guard is satisfied
        return {
          content: null,
          toolCalls: [
            { id: "w1", name: "write_file", arguments: { path: "index.html", content: '<html lang="en"></html>' } },
          ],
          usage: { promptTokens: 70, completionTokens: 30, totalTokens: 100 },
          finishReason: "tool_calls",
        };
      }
      return {
        content: null,
        toolCalls: [
          { id: "c1", name: "mark_task_complete", arguments: { summary: "Task done" } },
        ],
        usage: { promptTokens: 30, completionTokens: 20, totalTokens: 50 },
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
    const tmpMemoryFile = `/tmp/coord-memory-${Date.now()}.md`;
    trackedFiles.push(tmpPlanFile, tmpOutputDir, tmpMemoryFile);
    await Bun.write(tmpPlanFile, MULTI_TASK_PLAN);

    const { runImplementationCoordinator } = await import("../agents/implementation-coordinator.ts");
    const result = await runImplementationCoordinator(
      "gpt-4o",
      { text: "# Design", images: [] },
      tmpPlanFile,
      tmpMemoryFile,
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
    const tmpMemoryFile = `/tmp/coord-memory-ctx-${Date.now()}.md`;
    trackedFiles.push(tmpPlanFile, tmpOutputDir, tmpMemoryFile);
    await Bun.write(tmpPlanFile, MULTI_TASK_PLAN);

    const { runImplementationCoordinator } = await import("../agents/implementation-coordinator.ts");
    await runImplementationCoordinator("gpt-4o", { text: "# Design", images: [] }, tmpPlanFile, tmpMemoryFile, tmpOutputDir, "You are a coordinator.");

    expect(capturedContextArg).toBeDefined();
    expect(capturedContextArg!).toContain("Project Context");
    expect(capturedContextArg!).toContain("Tech Stack");
  });

  test("does not double-count token usage", async () => {
    const tmpPlanFile = `/tmp/coord-plan-tokens-${Date.now()}.md`;
    const tmpOutputDir = `/tmp/coord-output-tokens-${Date.now()}`;
    const tmpMemoryFile = `/tmp/coord-memory-tokens-${Date.now()}.md`;
    trackedFiles.push(tmpPlanFile, tmpOutputDir, tmpMemoryFile);
    // single task plan
    const singleTask = MULTI_TASK_PLAN.replace(
      /---\n\n### Task 2[\s\S]*/,
      "",
    );
    await Bun.write(tmpPlanFile, singleTask);

    const { runImplementationCoordinator } = await import("../agents/implementation-coordinator.ts");
    const result = await runImplementationCoordinator(
      "gpt-4o",
      { text: "# Design", images: [] },
      tmpPlanFile,
      tmpMemoryFile,
      tmpOutputDir,
      "You are a coordinator.",
    );

    // Mock returns 150 total tokens per task (write_file call: 100 + mark_complete call: 50). Should NOT be 300 (double-counted).
    expect(result.usage.totalTokens).toBe(150);
    expect(result.usage.promptTokens).toBe(100);
    expect(result.usage.completionTokens).toBe(50);
  });

  test("returns zero tasks when no pending tasks", async () => {
    const allDone = MULTI_TASK_PLAN.replace(/\*\*Status\*\*: pending/g, "**Status**: completed");
    const tmpPlanFile = `/tmp/coord-plan-done-${Date.now()}.md`;
    const tmpOutputDir = `/tmp/coord-output-done-${Date.now()}`;
    const tmpMemoryFile = `/tmp/coord-memory-done-${Date.now()}.md`;
    trackedFiles.push(tmpPlanFile, tmpOutputDir, tmpMemoryFile);
    await Bun.write(tmpPlanFile, allDone);

    const { runImplementationCoordinator } = await import("../agents/implementation-coordinator.ts");
    const result = await runImplementationCoordinator(
      "gpt-4o",
      { text: "# Design", images: [] },
      tmpPlanFile,
      tmpMemoryFile,
      tmpOutputDir,
      "You are a coordinator.",
    );

    expect(result.tasksCompleted).toBe(0);
  });
});

describe("design image stripping", () => {
  const fakeImage = { altText: "screenshot", data: "ZmFrZWRhdGE=", mimeType: "image/png" as const };

  function makePlan(task1Title: string, task2Title: string) {
    return `## Tech Stack\n- **Framework**: React\n\n---\n\n### Task 1: ${task1Title}\n**Status**: pending\n**Description**: Do it\n**Acceptance Criteria**: Done\n**Example Code**:\n\`\`\`\n\`\`\`\n\n---\n\n### Task 2: ${task2Title}\n**Status**: pending\n**Description**: Do it\n**Acceptance Criteria**: Done\n**Example Code**:\n\`\`\`\n\`\`\`\n`;
  }

  test("images are sent for task 1 but stripped for subsequent non-UI tasks", async () => {
    const contentTypes: ("array" | "string")[] = [];
    let seq = 0;

    mock.module("../llm/copilot-client.ts", () => ({
      CopilotClient: class {
        async chat(messages: unknown[]) {
          seq++;
          // Capture user message content on the first LLM call per task (odd seq = first call)
          if (seq % 2 === 1) {
            const msgs = messages as Array<{ role: string; content: unknown }>;
            const userMsg = msgs.find((m) => m.role === "user");
            contentTypes.push(Array.isArray(userMsg?.content) ? "array" : "string");
          }
          if (seq % 2 === 1) {
            return { content: null, toolCalls: [{ id: "w1", name: "write_file", arguments: { path: "f.html", content: "<h1>x</h1>" } }], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, finishReason: "tool_calls" as const };
          }
          return { content: null, toolCalls: [{ id: "c1", name: "mark_task_complete", arguments: { summary: "done" } }], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, finishReason: "tool_calls" as const };
        }
      },
    }));

    const tmpPlan = `/tmp/img-strip-plan-${Date.now()}.md`;
    const tmpOutput = `/tmp/img-strip-out-${Date.now()}`;
    const tmpMemory = `/tmp/img-strip-mem-${Date.now()}.md`;
    trackedFiles.push(tmpPlan, tmpOutput, tmpMemory);
    await Bun.write(tmpPlan, makePlan("Project Scaffold", "Add routing"));

    const { runImplementationCoordinator } = await import("../agents/implementation-coordinator.ts");
    await runImplementationCoordinator("gpt-4o", { text: "# Design", images: [fakeImage] }, tmpPlan, tmpMemory, tmpOutput, "sys");

    expect(contentTypes[0]).toBe("array");  // task 1: images included
    expect(contentTypes[1]).toBe("string"); // task 2: images stripped
  });

  test("images are preserved for UI-related tasks beyond task 1", async () => {
    const contentTypes: ("array" | "string")[] = [];
    let seq = 0;

    mock.module("../llm/copilot-client.ts", () => ({
      CopilotClient: class {
        async chat(messages: unknown[]) {
          seq++;
          if (seq % 2 === 1) {
            const msgs = messages as Array<{ role: string; content: unknown }>;
            const userMsg = msgs.find((m) => m.role === "user");
            contentTypes.push(Array.isArray(userMsg?.content) ? "array" : "string");
          }
          if (seq % 2 === 1) {
            return { content: null, toolCalls: [{ id: "w1", name: "write_file", arguments: { path: "g.html", content: "<h1>y</h1>" } }], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, finishReason: "tool_calls" as const };
          }
          return { content: null, toolCalls: [{ id: "c1", name: "mark_task_complete", arguments: { summary: "done" } }], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, finishReason: "tool_calls" as const };
        }
      },
    }));

    const tmpPlan = `/tmp/img-ui-plan-${Date.now()}.md`;
    const tmpOutput = `/tmp/img-ui-out-${Date.now()}`;
    const tmpMemory = `/tmp/img-ui-mem-${Date.now()}.md`;
    trackedFiles.push(tmpPlan, tmpOutput, tmpMemory);
    // Task 2 has "Style" in title → matches the UI regex
    await Bun.write(tmpPlan, makePlan("Project Scaffold", "Style the UI components"));

    const { runImplementationCoordinator } = await import("../agents/implementation-coordinator.ts");
    await runImplementationCoordinator("gpt-4o", { text: "# Design", images: [fakeImage] }, tmpPlan, tmpMemory, tmpOutput, "sys");

    expect(contentTypes[0]).toBe("array"); // task 1: images included
    expect(contentTypes[1]).toBe("array"); // task 2: "Style" → UI task, images kept
  });
});
