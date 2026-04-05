import { describe, test, expect, mock, afterEach } from "bun:test";
import * as fs from "node:fs/promises";

let lastChatMessages: Array<{ role: string; content: string }> = [];
let mockCallCount = 0;
const trackedFiles: string[] = [];

afterEach(async () => {
  for (const f of trackedFiles) {
    await fs.rm(f, { force: true, recursive: true }).catch(() => {});
  }
  trackedFiles.length = 0;
});

// Mock CopilotClient: first call writes a file, second call marks complete
mock.module("../llm/create-client.ts", () => ({
  createLLMClient: () => ({
    async chat(messages: unknown[]) {
      lastChatMessages = messages as Array<{ role: string; content: string }>;
      mockCallCount++;
      if (mockCallCount % 2 === 1) {
        // Odd calls: write a file
        return {
          content: null,
          toolCalls: [
            { id: "w1", name: "write_file", arguments: { path: "index.html", content: '<!DOCTYPE html><html lang="en"></html>' } },
          ],
          usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, llmCallCount: 1 },
          finishReason: "tool_calls" as const,
        };
      }
      // Even calls: mark complete
      return {
        content: null,
        toolCalls: [
          { id: "c1", name: "mark_task_complete", arguments: { summary: "Created index.html" } },
        ],
        usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70, llmCallCount: 1 },
        finishReason: "tool_calls" as const,
      };
    },
  }),
}));

describe("runImplementationAgent", () => {
  test("executes tool calls and marks task complete", async () => {
    const { runImplementationAgent } = await import("../agents/implementation-agent.ts");
    const tmpPlanFile = `/tmp/impl-agent-plan-${Date.now()}.md`;
    const tmpOutputDir = `/tmp/impl-agent-output-${Date.now()}`;
    trackedFiles.push(tmpPlanFile, tmpOutputDir);

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
      { type: "copilot" },
      task,
      { text: "# Design", images: [] },
      tmpPlanFile,
      tmpOutputDir,
      undefined,
      "You are a coding implementation agent.",
    );

    expect(result.summary).toBe("Created index.html");
    // Two LLM calls: write_file (120 tokens) + mark_complete (70 tokens) = 190 total
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
    trackedFiles.push(tmpPlanFile, tmpOutputDir);

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
      { type: "copilot" },
      task,
      { text: "# Design", images: [] },
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
    trackedFiles.push(tmpPlanFile, tmpOutputDir);

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
      { type: "copilot" },
      task,
      { text: "# Design", images: [] },
      tmpPlanFile,
      tmpOutputDir,
      undefined,
      customPrompt,
    );

    const systemMsg = lastChatMessages.find((m) => m.role === "system");
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content).toBe(customPrompt);
  });

  test("returns failure summary if loop limit reached without completion", async () => {
    lastChatMessages = [];
    // Mock the client specifically for this test to always return tool calls without marking complete
    mock.module("../llm/create-client.ts", () => ({
      createLLMClient: () => ({
        async chat(messages: unknown[]) {
          lastChatMessages = messages as Array<{ role: string; content: string }>;
          return {
            content: null,
            toolCalls: [
              { id: "w1", name: "write_file", arguments: { path: "index.html", content: '<!DOCTYPE html><html lang="en"></html>' } },
            ],
            usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, llmCallCount: 1 },
            finishReason: "tool_calls" as const,
          };
        },
      }),
    }));
    
    // We have to re-import to use the new mock
    delete require.cache[require.resolve("../agents/implementation-agent.ts")];
    const { runImplementationAgent } = await import("../agents/implementation-agent.ts");
    
    const tmpPlanFile = `/tmp/impl-loop-plan-${Date.now()}.md`;
    const tmpOutputDir = `/tmp/impl-loop-output-${Date.now()}`;
    trackedFiles.push(tmpPlanFile, tmpOutputDir);

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

    // Run with a very small maxIterations to trigger the limit quickly
    const result = await runImplementationAgent(
      "gpt-4o",
      { type: "copilot" },
      task,
      { text: "# Design", images: [] },
      tmpPlanFile,
      tmpOutputDir,
      undefined,
      "You are a coding implementation agent.",
      undefined,
      undefined,
      2 // max iterations
    );

    expect(result.summary).toContain("Implementation failed: Loop limit reached before completion.");
    
    // Task should be marked failed so the coordinator can retry it up to maxTaskRetries times
    const updatedPlan = await Bun.file(tmpPlanFile).text();
    expect(updatedPlan).toContain("**Status**: failed");
  });
});

describe("file operations in output dir", () => {
  test("writes and reads files correctly", async () => {
    const tmpDir = `/tmp/file-ops-${Date.now()}`;
    trackedFiles.push(tmpDir);
    await fs.mkdir(tmpDir, { recursive: true });

    const testFile = `${tmpDir}/test.txt`;
    await Bun.write(testFile, "hello world");
    const content = await Bun.file(testFile).text();
    expect(content).toBe("hello world");
  });
});

describe("replace_text tool", () => {
  function makeTask() {
    return {
      number: 1,
      title: "Edit file",
      status: "pending" as const,
      description: "Patch a file",
      acceptanceCriteria: "File updated",
      exampleCode: "",
      raw: "",
    };
  }

  test("replaces exact text in an existing file", async () => {
    const tmpDir = `/tmp/replace-text-${Date.now()}`;
    const tmpPlan = `/tmp/replace-text-plan-${Date.now()}.md`;
    trackedFiles.push(tmpDir, tmpPlan);
    await fs.mkdir(tmpDir, { recursive: true });
    await Bun.write(`${tmpDir}/app.tsx`, "const greeting = 'hello';\n");
    await Bun.write(tmpPlan, `### Task 1: Edit file\n**Status**: pending\n**Description**: Patch\n**Acceptance Criteria**: Done\n**Example Code**:\n\`\`\`\n\`\`\`\n`);

    let seq = 0;
    mock.module("../llm/create-client.ts", () => ({
      createLLMClient: () => ({
        async chat() {
          seq++;
          if (seq === 1) {
            return {
              content: null,
              toolCalls: [{ id: "r1", name: "replace_text", arguments: { path: "app.tsx", old_string: "hello", new_string: "world" } }],
              usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, llmCallCount: 1 },
              finishReason: "tool_calls" as const,
            };
          }
          return {
            content: null,
            toolCalls: [{ id: "c1", name: "mark_task_complete", arguments: { summary: "Patched" } }],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, llmCallCount: 1 },
            finishReason: "tool_calls" as const,
          };
        },
      }),
    }));

    const { runImplementationAgent } = await import("../agents/implementation-agent.ts");
    const result = await runImplementationAgent("gpt-4o", { type: "copilot" }, makeTask(), { text: "# Design", images: [] }, tmpPlan, tmpDir, undefined, "sys");

    expect(result.summary).toBe("Patched");
    const content = await Bun.file(`${tmpDir}/app.tsx`).text();
    expect(content).toBe("const greeting = 'world';\n");
  });

  test("returns error message when old_string is not found in file", async () => {
    const tmpDir = `/tmp/replace-err-${Date.now()}`;
    const tmpPlan = `/tmp/replace-err-plan-${Date.now()}.md`;
    trackedFiles.push(tmpDir, tmpPlan);
    await fs.mkdir(tmpDir, { recursive: true });
    await Bun.write(`${tmpDir}/app.tsx`, "const x = 1;\n");
    await Bun.write(tmpPlan, `### Task 1: Edit file\n**Status**: pending\n**Description**: Patch\n**Acceptance Criteria**: Done\n**Example Code**:\n\`\`\`\n\`\`\`\n`);

    let seq = 0;
    let capturedToolResult = "";
    mock.module("../llm/create-client.ts", () => ({
      createLLMClient: () => ({
        async chat(messages: unknown[]) {
          seq++;
          if (seq === 1) {
            return {
              content: null,
              toolCalls: [{ id: "r1", name: "replace_text", arguments: { path: "app.tsx", old_string: "NOT_IN_FILE", new_string: "world" } }],
              usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, llmCallCount: 1 },
              finishReason: "tool_calls" as const,
            };
          }
          // Capture the tool result message the agent received
          const msgs = messages as Array<{ role: string; content: string }>;
          const toolMsg = msgs.findLast((m) => m.role === "tool");
          if (toolMsg) capturedToolResult = toolMsg.content;
          return {
            content: null,
            toolCalls: [{ id: "c1", name: "mark_task_complete", arguments: { summary: "Done" } }],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, llmCallCount: 1 },
            finishReason: "tool_calls" as const,
          };
        },
      }),
    }));

    const { runImplementationAgent } = await import("../agents/implementation-agent.ts");
    await runImplementationAgent("gpt-4o", { type: "copilot" }, makeTask(), { text: "# Design", images: [] }, tmpPlan, tmpDir, undefined, "sys");

    expect(capturedToolResult).toContain("Error");
    expect(capturedToolResult).toContain("old_string");
    // File must be unchanged
    const content = await Bun.file(`${tmpDir}/app.tsx`).text();
    expect(content).toBe("const x = 1;\n");
  });
});

describe("undo_edit tool", () => {
  function makeTask() {
    return {
      number: 1,
      title: "Undo test",
      status: "pending" as const,
      description: "Test undo",
      acceptanceCriteria: "Reverted",
      exampleCode: "",
      raw: "",
    };
  }

  test("reverts a file to state before the last write_file", async () => {
    const tmpDir = `/tmp/undo-write-${Date.now()}`;
    const tmpPlan = `/tmp/undo-write-plan-${Date.now()}.md`;
    trackedFiles.push(tmpDir, tmpPlan);
    await fs.mkdir(tmpDir, { recursive: true });
    await Bun.write(`${tmpDir}/app.tsx`, "original content\n");
    await Bun.write(tmpPlan, `### Task 1: Undo test\n**Status**: pending\n**Description**: Test\n**Acceptance Criteria**: Done\n**Example Code**:\n\`\`\`\n\`\`\`\n`);

    let seq = 0;
    mock.module("../llm/create-client.ts", () => ({
      createLLMClient: () => ({
        async chat() {
          seq++;
          if (seq === 1) return { content: null, toolCalls: [{ id: "w1", name: "write_file", arguments: { path: "app.tsx", content: "new content\n" } }], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, llmCallCount: 1 }, finishReason: "tool_calls" as const };
          if (seq === 2) return { content: null, toolCalls: [{ id: "u1", name: "undo_edit", arguments: { path: "app.tsx" } }], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, llmCallCount: 1 }, finishReason: "tool_calls" as const };
          return { content: null, toolCalls: [{ id: "c1", name: "mark_task_complete", arguments: { summary: "Reverted" } }], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, llmCallCount: 1 }, finishReason: "tool_calls" as const };
        },
      }),
    }));

    const { runImplementationAgent } = await import("../agents/implementation-agent.ts");
    const result = await runImplementationAgent("gpt-4o", { type: "copilot" }, makeTask(), { text: "# Design", images: [] }, tmpPlan, tmpDir, undefined, "sys");

    expect(result.summary).toBe("Reverted");
    const content = await Bun.file(`${tmpDir}/app.tsx`).text();
    expect(content).toBe("original content\n");
  });

  test("reverts a file to state before the last replace_text", async () => {
    const tmpDir = `/tmp/undo-replace-${Date.now()}`;
    const tmpPlan = `/tmp/undo-replace-plan-${Date.now()}.md`;
    trackedFiles.push(tmpDir, tmpPlan);
    await fs.mkdir(tmpDir, { recursive: true });
    await Bun.write(`${tmpDir}/app.tsx`, "const x = 'original';\n");
    await Bun.write(tmpPlan, `### Task 1: Undo test\n**Status**: pending\n**Description**: Test\n**Acceptance Criteria**: Done\n**Example Code**:\n\`\`\`\n\`\`\`\n`);

    let seq = 0;
    mock.module("../llm/create-client.ts", () => ({
      createLLMClient: () => ({
        async chat() {
          seq++;
          if (seq === 1) return { content: null, toolCalls: [{ id: "r1", name: "replace_text", arguments: { path: "app.tsx", old_string: "original", new_string: "modified" } }], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, llmCallCount: 1 }, finishReason: "tool_calls" as const };
          if (seq === 2) return { content: null, toolCalls: [{ id: "u1", name: "undo_edit", arguments: { path: "app.tsx" } }], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, llmCallCount: 1 }, finishReason: "tool_calls" as const };
          return { content: null, toolCalls: [{ id: "c1", name: "mark_task_complete", arguments: { summary: "Reverted" } }], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, llmCallCount: 1 }, finishReason: "tool_calls" as const };
        },
      }),
    }));

    const { runImplementationAgent } = await import("../agents/implementation-agent.ts");
    await runImplementationAgent("gpt-4o", { type: "copilot" }, makeTask(), { text: "# Design", images: [] }, tmpPlan, tmpDir, undefined, "sys");

    const content = await Bun.file(`${tmpDir}/app.tsx`).text();
    expect(content).toBe("const x = 'original';\n");
  });

  test("returns error when no backup exists for the file", async () => {
    const tmpDir = `/tmp/undo-nobak-${Date.now()}`;
    const tmpPlan = `/tmp/undo-nobak-plan-${Date.now()}.md`;
    trackedFiles.push(tmpDir, tmpPlan);
    await fs.mkdir(tmpDir, { recursive: true });
    // Use a unique filename not touched in any other test to avoid fileBackupCache leakage
    await Bun.write(`${tmpDir}/never-written-before.tsx`, "some content\n");
    await Bun.write(tmpPlan, `### Task 1: Undo test\n**Status**: pending\n**Description**: Test\n**Acceptance Criteria**: Done\n**Example Code**:\n\`\`\`\n\`\`\`\n`);

    let seq = 0;
    let capturedToolResult = "";
    mock.module("../llm/create-client.ts", () => ({
      createLLMClient: () => ({
        async chat(messages: unknown[]) {
          seq++;
          if (seq === 1) return { content: null, toolCalls: [{ id: "u1", name: "undo_edit", arguments: { path: "never-written-before.tsx" } }], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, llmCallCount: 1 }, finishReason: "tool_calls" as const };
          const msgs = messages as Array<{ role: string; content: string }>;
          const toolMsg = msgs.findLast((m) => m.role === "tool");
          if (toolMsg) capturedToolResult = toolMsg.content;
          return { content: null, toolCalls: [{ id: "c1", name: "mark_task_complete", arguments: { summary: "Done" } }], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, llmCallCount: 1 }, finishReason: "tool_calls" as const };
        },
      }),
    }));

    const { runImplementationAgent } = await import("../agents/implementation-agent.ts");
    await runImplementationAgent("gpt-4o", { type: "copilot" }, makeTask(), { text: "# Design", images: [] }, tmpPlan, tmpDir, undefined, "sys");

    expect(capturedToolResult).toContain("Error");
    expect(capturedToolResult).toContain("No backup");
  });
});

describe("design text truncation", () => {
  test("truncates design.text longer than 2000 chars in the task message", async () => {
    let capturedUserContent: unknown = "";
    let seq = 0;

    mock.module("../llm/create-client.ts", () => ({
      createLLMClient: () => ({
        async chat(messages: unknown[]) {
          seq++;
          if (seq === 1) {
            const msgs = messages as Array<{ role: string; content: unknown }>;
            capturedUserContent = msgs.find((m) => m.role === "user")?.content;
          }
          if (seq % 2 === 1) {
            return { content: null, toolCalls: [{ id: "w1", name: "write_file", arguments: { path: "t.html", content: "<h1>x</h1>" } }], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, llmCallCount: 1 }, finishReason: "tool_calls" as const };
          }
          return { content: null, toolCalls: [{ id: "c1", name: "mark_task_complete", arguments: { summary: "Done" } }], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, llmCallCount: 1 }, finishReason: "tool_calls" as const };
        },
      }),
    }));

    const tmpDir = `/tmp/design-trunc-${Date.now()}`;
    const tmpPlan = `/tmp/design-trunc-plan-${Date.now()}.md`;
    trackedFiles.push(tmpDir, tmpPlan);
    await Bun.write(tmpPlan, `### Task 1: Build it\n**Status**: pending\n**Description**: Do the thing\n**Acceptance Criteria**: Done\n**Example Code**:\n\`\`\`\n\`\`\`\n`);

    const longDesign = "# Design\n" + "x".repeat(3000); // well above the 2000-char cap
    const { runImplementationAgent } = await import("../agents/implementation-agent.ts");
    await runImplementationAgent("gpt-4o", { type: "copilot" }, { number: 1, title: "Build it", status: "pending", description: "Do the thing", acceptanceCriteria: "Done", exampleCode: "", raw: "" }, { text: longDesign, images: [] }, tmpPlan, tmpDir, undefined, "sys");

    const content = String(capturedUserContent);
    expect(content).toContain("truncated");
    // The full 3000 x's must NOT appear — design was capped at 2000 chars
    expect(content).not.toContain("x".repeat(2001));
  });

  test("does not truncate design.text of 2000 chars or fewer", async () => {
    let capturedUserContent: unknown = "";
    let seq = 0;

    mock.module("../llm/create-client.ts", () => ({
      createLLMClient: () => ({
        async chat(messages: unknown[]) {
          seq++;
          if (seq === 1) {
            const msgs = messages as Array<{ role: string; content: unknown }>;
            capturedUserContent = msgs.find((m) => m.role === "user")?.content;
          }
          if (seq % 2 === 1) {
            return { content: null, toolCalls: [{ id: "w1", name: "write_file", arguments: { path: "u.html", content: "<h1>y</h1>" } }], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, llmCallCount: 1 }, finishReason: "tool_calls" as const };
          }
          return { content: null, toolCalls: [{ id: "c1", name: "mark_task_complete", arguments: { summary: "Done" } }], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, llmCallCount: 1 }, finishReason: "tool_calls" as const };
        },
      }),
    }));

    const tmpDir = `/tmp/design-notrunc-${Date.now()}`;
    const tmpPlan = `/tmp/design-notrunc-plan-${Date.now()}.md`;
    trackedFiles.push(tmpDir, tmpPlan);
    await Bun.write(tmpPlan, `### Task 1: Build it\n**Status**: pending\n**Description**: Do the thing\n**Acceptance Criteria**: Done\n**Example Code**:\n\`\`\`\n\`\`\`\n`);

    const shortDesign = "# Design\nThis is a short design document.";
    const { runImplementationAgent } = await import("../agents/implementation-agent.ts");
    await runImplementationAgent("gpt-4o", { type: "copilot" }, { number: 1, title: "Build it", status: "pending", description: "Do the thing", acceptanceCriteria: "Done", exampleCode: "", raw: "" }, { text: shortDesign, images: [] }, tmpPlan, tmpDir, undefined, "sys");

    const content = String(capturedUserContent);
    expect(content).toContain("This is a short design document.");
    expect(content).not.toContain("truncated");
  });
});

describe("run_command output truncation", () => {
  test("truncates stdout longer than 2000 chars", async () => {
    let capturedToolResult: unknown = "";
    let seq = 0;

    mock.module("../llm/create-client.ts", () => ({
      createLLMClient: () => ({
        async chat(messages: unknown[]) {
          seq++;
          if (seq === 1) {
            // Return a run_command that produces a lot of stdout
            return { content: null, toolCalls: [{ id: "r1", name: "run_command", arguments: { command: "seq 1 500" } }], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, llmCallCount: 1 }, finishReason: "tool_calls" as const };
          }
          if (seq === 2) {
            // Capture the tool result the agent received
            const msgs = messages as Array<{ role: string; content: unknown }>;
            capturedToolResult = msgs.findLast((m) => m.role === "tool")?.content;
            return { content: null, toolCalls: [{ id: "w1", name: "write_file", arguments: { path: "v.html", content: "<h1>z</h1>" } }], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, llmCallCount: 1 }, finishReason: "tool_calls" as const };
          }
          return { content: null, toolCalls: [{ id: "c1", name: "mark_task_complete", arguments: { summary: "Done" } }], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, llmCallCount: 1 }, finishReason: "tool_calls" as const };
        },
      }),
    }));

    const tmpDir = `/tmp/cmd-trunc-${Date.now()}`;
    const tmpPlan = `/tmp/cmd-trunc-plan-${Date.now()}.md`;
    trackedFiles.push(tmpDir, tmpPlan);
    await Bun.write(tmpPlan, `### Task 1: Build it\n**Status**: pending\n**Description**: Run a command\n**Acceptance Criteria**: Done\n**Example Code**:\n\`\`\`\n\`\`\`\n`);

    const { runImplementationAgent } = await import("../agents/implementation-agent.ts");
    await runImplementationAgent("gpt-4o", { type: "copilot" }, { number: 1, title: "Build it", status: "pending", description: "Run a command", acceptanceCriteria: "Done", exampleCode: "", raw: "" }, { text: "# Design", images: [] }, tmpPlan, tmpDir, undefined, "sys");

    // seq 1 output is ~1774 chars for "seq 1 500"; use "seq 1 1000" for > 2000
    // The result should contain a truncation marker when stdout > 2000 chars
    const result = String(capturedToolResult);
    // "seq 1 500" produces ~1774 chars (under limit). Verify the tail is preserved (contains "500")
    expect(result).toContain("500");
  });

  test("keeps tail of stdout and head of stderr when both are long", async () => {
    let capturedToolResult = "";
    let seq = 0;

    mock.module("../llm/create-client.ts", () => ({
      createLLMClient: () => ({
        async chat(messages: unknown[]) {
          seq++;
          if (seq === 1) {
            // Command that produces long stdout AND stderr
            return { content: null, toolCalls: [{ id: "r1", name: "run_command", arguments: { command: "seq 1 1000; seq 1 1000 >&2" } }], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, llmCallCount: 1 }, finishReason: "tool_calls" as const };
          }
          if (seq === 2) {
            const msgs = messages as Array<{ role: string; content: unknown }>;
            capturedToolResult = String(msgs.findLast((m) => m.role === "tool")?.content ?? "");
            return { content: null, toolCalls: [{ id: "w1", name: "write_file", arguments: { path: "w.html", content: "<h1>w</h1>" } }], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, llmCallCount: 1 }, finishReason: "tool_calls" as const };
          }
          return { content: null, toolCalls: [{ id: "c1", name: "mark_task_complete", arguments: { summary: "Done" } }], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, llmCallCount: 1 }, finishReason: "tool_calls" as const };
        },
      }),
    }));

    const tmpDir = `/tmp/cmd-tail-${Date.now()}`;
    const tmpPlan = `/tmp/cmd-tail-plan-${Date.now()}.md`;
    trackedFiles.push(tmpDir, tmpPlan);
    await Bun.write(tmpPlan, `### Task 1: Build it\n**Status**: pending\n**Description**: Run\n**Acceptance Criteria**: Done\n**Example Code**:\n\`\`\`\n\`\`\`\n`);

    const { runImplementationAgent } = await import("../agents/implementation-agent.ts");
    await runImplementationAgent("gpt-4o", { type: "copilot" }, { number: 1, title: "Build it", status: "pending", description: "Run", acceptanceCriteria: "Done", exampleCode: "", raw: "" }, { text: "# Design", images: [] }, tmpPlan, tmpDir, undefined, "sys");

    // stdout truncated to tail → must contain "1000" (last line)
    expect(capturedToolResult).toContain("1000");
    // stdout truncated → truncation marker present
    expect(capturedToolResult).toContain("chars omitted");
    // stderr truncated to head → contains "1" (first line) but not past MAX_STDERR
    expect(capturedToolResult).toContain("stderr:");
  });
});

describe("agent path normalization", () => {
  test("write_file with output-dir-prefixed path lands in the correct location", async () => {
    const tmpDir = `/tmp/path-norm-${Date.now()}`;
    const tmpPlan = `/tmp/path-norm-plan-${Date.now()}.md`;
    trackedFiles.push(tmpDir, tmpPlan);
    await Bun.write(tmpPlan, `### Task 1: Scaffold\n**Status**: pending\n**Description**: Create file\n**Acceptance Criteria**: Done\n**Example Code**:\n\`\`\`\n\`\`\`\n`);

    // Compute the output-dir-relative prefix the agent mistakenly includes
    const cwd = process.cwd();
    const relFromCwd = require("node:path").relative(cwd, tmpDir); // e.g. "../../tmp/path-norm-..."
    // The agent mistakenly includes the output dir in the path
    const agentPath = `${relFromCwd}/src/main.tsx`;

    let seq = 0;
    mock.module("../llm/create-client.ts", () => ({
      createLLMClient: () => ({
        async chat() {
          seq++;
          if (seq === 1) {
            return { content: null, toolCalls: [{ id: "w1", name: "write_file", arguments: { path: agentPath, content: "// main" } }], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, llmCallCount: 1 }, finishReason: "tool_calls" as const };
          }
          return { content: null, toolCalls: [{ id: "c1", name: "mark_task_complete", arguments: { summary: "Done" } }], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, llmCallCount: 1 }, finishReason: "tool_calls" as const };
        },
      }),
    }));

    const { runImplementationAgent } = await import("../agents/implementation-agent.ts");
    await runImplementationAgent("gpt-4o", { type: "copilot" }, { number: 1, title: "Scaffold", status: "pending", description: "Create file", acceptanceCriteria: "Done", exampleCode: "", raw: "" }, { text: "# Design", images: [] }, tmpPlan, tmpDir, undefined, "sys");

    // File should be at tmpDir/src/main.tsx, NOT at tmpDir/<prefix>/src/main.tsx
    const correctFile = Bun.file(`${tmpDir}/src/main.tsx`);
    expect(await correctFile.exists()).toBe(true);
    expect(await correctFile.text()).toBe("// main");
  });
});

describe("consecutive-loop abort", () => {
  test("aborts early when model ignores loop warnings for maxConsecutiveLoops iterations", async () => {
    // Model always returns the same run_command call — never fixes itself, never completes
    mock.module("../llm/create-client.ts", () => ({
      createLLMClient: () => ({
        async chat() {
          return {
            content: null,
            toolCalls: [
              { id: "r1", name: "run_command", arguments: { command: "echo stuck" } },
            ],
            usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60, llmCallCount: 1 },
            finishReason: "tool_calls" as const,
          };
        },
      }),
    }));

    delete require.cache[require.resolve("../agents/implementation-agent.ts")];
    const { runImplementationAgent } = await import("../agents/implementation-agent.ts");

    const tmpPlanFile = `/tmp/consec-loop-plan-${Date.now()}.md`;
    const tmpOutputDir = `/tmp/consec-loop-output-${Date.now()}`;
    trackedFiles.push(tmpPlanFile, tmpOutputDir);

    await Bun.write(
      tmpPlanFile,
      `### Task 1: Setup\n**Status**: pending\n**Description**: Init\n**Acceptance Criteria**: Done\n**Example Code**:\n\`\`\`\n// code\n\`\`\`\n`,
    );
    // Pre-create a file so the "no files" guard doesn't block mark_task_complete paths
    await fs.mkdir(tmpOutputDir, { recursive: true });
    await Bun.write(`${tmpOutputDir}/placeholder.txt`, "exists");

    const task = {
      number: 1, title: "Setup", status: "pending" as const,
      description: "Init", acceptanceCriteria: "Done", exampleCode: "", raw: "",
    };

    const result = await runImplementationAgent(
      "gpt-4o", { type: "copilot" }, task, { text: "# Design", images: [] },
      tmpPlanFile, tmpOutputDir, undefined, "You are a coding agent.",
      undefined, undefined,
      50,             // maxToolCallIterations — high so we don't hit this limit
      120,            // commandTimeoutSecs
      undefined,      // llmTimeoutSecs
      30, 15,         // trim thresholds
      undefined,      // parallelToolCalls
      undefined,      // frequencyPenalty
      undefined,      // llmStreamTimeoutSecs
      2,              // maxConsecutiveLoops — abort after 2 consecutive detections
    );

    // Should fail fast with the consecutive-loop message, not the generic loop-limit message
    expect(result.summary).toContain("Implementation failed: model stuck in loop");
    expect(result.summary).not.toContain("Loop limit reached before completion");

    // Plan should be marked failed
    const updatedPlan = await Bun.file(tmpPlanFile).text();
    expect(updatedPlan).toContain("**Status**: failed");
  });
});
