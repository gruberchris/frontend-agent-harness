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

// Mock the CopilotClient to avoid real API calls
const mockChatFn = mock(async (messages: unknown[]) => {
  lastChatCallMessages = messages as Array<{ role: string; content: string | null }>;
  return {
    content: generateMockPlan(),
    toolCalls: [],
    usage: { promptTokens: 100, completionTokens: 500, totalTokens: 600 },
    finishReason: "stop" as const,
  };
});

mock.module("../llm/copilot-client.ts", () => ({
  CopilotClient: class MockCopilotClient {
    constructor(_model: string) {}
    chat = mockChatFn;
  },
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

describe("runTaskAgent", () => {
  test("generates plan.md from design content", async () => {
    const { runTaskAgent } = await import("../agents/task-agent.ts");
    const tmpPlanFile = `/tmp/task-agent-plan-${Date.now()}.md`;
    const tmpMemoryFile = `/tmp/task-agent-memory-${Date.now()}.md`;
    trackedFiles.push(tmpPlanFile, tmpMemoryFile);
    const systemPrompt = "You are an expert software architect.";

    const result = await runTaskAgent("gpt-4o", "# My App\n\nA todo app with React.", tmpPlanFile, tmpMemoryFile, systemPrompt);

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

    const result = await runTaskAgent("gpt-4o", "Simple design", tmpPlanFile, tmpMemoryFile, "You are an architect.");
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  });

  test("uses the provided systemPrompt directly", async () => {
    lastChatCallMessages = [];
    const { runTaskAgent } = await import("../agents/task-agent.ts");
    const tmpPlanFile = `/tmp/task-agent-plan-${Date.now()}.md`;
    const tmpMemoryFile = `/tmp/task-agent-memory-${Date.now()}.md`;
    trackedFiles.push(tmpPlanFile, tmpMemoryFile);
    const customPrompt = "You are a specialist in React applications.";

    await runTaskAgent("gpt-4o", "# My App", tmpPlanFile, tmpMemoryFile, customPrompt);

    const systemMsg = lastChatCallMessages.find((m) => m.role === "system");
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content).toBe(customPrompt);
  });
});
