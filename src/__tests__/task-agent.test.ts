import { describe, test, expect, mock, afterEach } from "bun:test";
import * as fs from "node:fs/promises";

let lastChatCallMessages: Array<{ role: string; content: string | null }> = [];
const trackedFiles: string[] = [];

afterEach(async () => {
  for (const f of trackedFiles) {
    await fs.rm(f, { force: true, recursive: true }).catch(() => {});
  }
  trackedFiles.length = 0;
});

// Mock createLLMClient to avoid real API calls
const mockChatFn = mock(async (messages: unknown[]) => {
  lastChatCallMessages = messages as Array<{ role: string; content: string | null }>;
  // Detect correction mode by looking at the user message content
  const userMsg = lastChatCallMessages.find((m) => m.role === "user");
  const isCorrection = typeof userMsg?.content === "string" && userMsg.content.startsWith("CORRECTION MODE");
  const taskNum = isCorrection
    ? parseInt((userMsg!.content as string).match(/numbered starting from Task (\d+)/)?.[1] ?? "3", 10)
    : 1;
  return {
    content: isCorrection ? generateMockCorrectionTask(taskNum) : generateMockPlan(),
    toolCalls: [],
    usage: { promptTokens: 100, completionTokens: 500, totalTokens: 600, llmCallCount: 1 },
    finishReason: "stop" as const,
  };
});

mock.module("../llm/create-client.ts", () => ({
  createLLMClient: () => ({ chat: mockChatFn }),
}));

function generateMockPlan(): string {
  return `### Task 1: Setup scaffold
**Status**: pending
**Description**: Initialize the project
**Acceptance Criteria**: Project structure exists
**Example Code**:
\`\`\`typescript
console.log("hello");
\`\`\`

---

### Task 2: Create main component
**Status**: pending
**Description**: Build the main component
**Acceptance Criteria**: Component renders without errors
**Example Code**:
\`\`\`tsx
export const App = () => <div>Hello</div>
\`\`\`
`;
}

function generateMockCorrectionTask(n: number): string {
  return `### Task ${n}: Fix: typo in variable name
**Status**: pending
**Description**: Fix the typo
**Acceptance Criteria**: No runtime errors
**Example Code**:
\`\`\`typescript
const newPassword = generate();
\`\`\`
`;
}

describe("runTaskAgent", () => {
  test("generates plan.md from design content", async () => {
    const { runTaskAgent } = await import("../agents/task-agent.ts");
    const tmpPlanFile = `/tmp/task-agent-plan-${Date.now()}.md`;
    const tmpMemoryFile = `/tmp/task-agent-memory-${Date.now()}.md`;
    trackedFiles.push(tmpPlanFile, tmpMemoryFile);
    const systemPrompt = "You are an expert software architect.";

    const result = await runTaskAgent("gpt-4o", { type: "copilot" }, { text: "# My App\n\nA todo app with React.", images: [] }, tmpPlanFile, tmpMemoryFile, systemPrompt);

    expect(result.planContent).toContain("Task 1");
    expect(result.planContent).toContain("pending");
    expect(result.usage.promptTokens).toBe(100);
    expect(result.usage.completionTokens).toBe(500);

    // Verify file was written
    const written = await Bun.file(tmpPlanFile).text();
    expect(written).toContain("Task 1");
  });

  test("returns token usage from LLM call", async () => {
    const { runTaskAgent } = await import("../agents/task-agent.ts");
    const tmpPlanFile = `/tmp/task-agent-plan-${Date.now()}.md`;
    const tmpMemoryFile = `/tmp/task-agent-memory-${Date.now()}.md`;
    trackedFiles.push(tmpPlanFile, tmpMemoryFile);

    const result = await runTaskAgent("gpt-4o", { type: "copilot" }, { text: "Simple design", images: [] }, tmpPlanFile, tmpMemoryFile, "You are an architect.");
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  });

  test("uses the provided systemPrompt directly", async () => {
    lastChatCallMessages = [];
    const { runTaskAgent } = await import("../agents/task-agent.ts");
    const tmpPlanFile = `/tmp/task-agent-plan-${Date.now()}.md`;
    const tmpMemoryFile = `/tmp/task-agent-memory-${Date.now()}.md`;
    trackedFiles.push(tmpPlanFile, tmpMemoryFile);
    const customPrompt = "You are a specialist in React applications.";

    await runTaskAgent("gpt-4o", { type: "copilot" }, { text: "# My App", images: [] }, tmpPlanFile, tmpMemoryFile, customPrompt);

    const systemMsg = lastChatCallMessages.find((m) => m.role === "system");
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content).toBe(customPrompt);
  });

  test("correction mode appends tasks to existing plan instead of replacing it", async () => {
    lastChatCallMessages = [];
    const { runTaskAgent } = await import("../agents/task-agent.ts");
    const tmpPlanFile = `/tmp/task-agent-plan-${Date.now()}.md`;
    const tmpMemoryFile = `/tmp/task-agent-memory-${Date.now()}.md`;
    trackedFiles.push(tmpPlanFile, tmpMemoryFile);

    // Write an existing plan with completed tasks
    const existingPlan = `## Tech Stack\n- Framework: React\n\n### Task 1: Setup scaffold\n**Status**: completed\n**Description**: done\n**Acceptance Criteria**: done\n`;
    await Bun.write(tmpPlanFile, existingPlan);
    await Bun.write(tmpMemoryFile, "ReferenceError: newPMassword is not defined in src/App.tsx");

    await runTaskAgent(
      "gpt-4o", { type: "copilot" },
      { text: "# My App", images: [] },
      tmpPlanFile, tmpMemoryFile,
      "You are an architect.",
      undefined, undefined, undefined, undefined,
      true, // correctionMode
      2,    // nextTaskNumber
    );

    const written = await Bun.file(tmpPlanFile).text();
    // Must preserve the original plan
    expect(written).toContain("Task 1: Setup scaffold");
    expect(written).toContain("completed");
    // Must append the new correction task
    expect(written).toContain("Task 2:");
  });

  test("correction mode user message starts with CORRECTION MODE", async () => {
    lastChatCallMessages = [];
    const { runTaskAgent } = await import("../agents/task-agent.ts");
    const tmpPlanFile = `/tmp/task-agent-plan-${Date.now()}.md`;
    const tmpMemoryFile = `/tmp/task-agent-memory-${Date.now()}.md`;
    trackedFiles.push(tmpPlanFile, tmpMemoryFile);
    await Bun.write(tmpPlanFile, "### Task 1: Scaffold\n**Status**: completed\n**Description**: d\n**Acceptance Criteria**: d\n");
    await Bun.write(tmpMemoryFile, "Some evaluator finding");

    await runTaskAgent(
      "gpt-4o", { type: "copilot" },
      { text: "# My App", images: [] },
      tmpPlanFile, tmpMemoryFile,
      "You are an architect.",
      undefined, undefined, undefined, undefined,
      true, 2,
    );

    const userMsg = lastChatCallMessages.find((m) => m.role === "user");
    expect(typeof userMsg?.content).toBe("string");
    expect((userMsg!.content as string).startsWith("CORRECTION MODE")).toBe(true);
    expect(userMsg!.content as string).toContain("Task 2");
  });
});

