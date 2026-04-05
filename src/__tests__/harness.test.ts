import { describe, test, expect, mock, afterEach } from "bun:test";
import * as fs from "node:fs/promises";

const trackedFiles: string[] = [];

afterEach(async () => {
  for (const f of trackedFiles) {
    await fs.rm(f, { force: true, recursive: true }).catch(() => {});
  }
  trackedFiles.length = 0;
  // Reset coordinator result to the default happy path after each test
  coordResult = {
    tasksCompleted: 1,
    usage: { promptTokens: 500, completionTokens: 1000, totalTokens: 1500, llmCallCount: 8 },
  };
});

// Full pipeline harness integration tests with all agents mocked

mock.module("../agents/task-agent.ts", () => ({
  runTaskAgent: mock(async (_model: string, _providerConfig: unknown, _design: unknown, planFile: string) => {
    await Bun.write(
      planFile,
      `### Task 1: Build app
**Status**: pending
**Description**: Create the app
**Acceptance Criteria**: App runs
**Example Code**:
\`\`\`typescript
console.log("hello");
\`\`\`
`,
    );
    return {
      planContent: "mock plan",
      usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300, llmCallCount: 1 },
    };
  }),
}));

mock.module("../agents/implementation-coordinator.ts", () => ({
  runImplementationCoordinator: mock(async () => coordResult),
}));

let coordResult: {
  tasksCompleted: number;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number; llmCallCount: number };
  permanentlyFailedTask?: { number: number; title: string };
} = {
  tasksCompleted: 1,
  usage: { promptTokens: 500, completionTokens: 1000, totalTokens: 1500, llmCallCount: 8 },
};

let evalCallCount = 0;
let evalShouldPass = true;
let evalPassFromCallN = 1; // pass starting from this call number (1-indexed); default = always pass

mock.module("../agents/evaluator-agent.ts", () => ({
  runEvaluatorAgent: mock(async () => {
    evalCallCount++;
    if (evalShouldPass && evalCallCount >= evalPassFromCallN) {
      return {
        decision: "PASS",
        explanation: "All good",
        usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300, llmCallCount: 3 },
      };
    }
    return {
      decision: "NEEDS_WORK",
      explanation: "Issues found",
      usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300, llmCallCount: 5 },
    };
  }),
}));

mock.module("../server/dev-server.ts", () => ({
  startDevServer: mock(async () => ({
    url: "http://localhost:3000",
    stop: async () => {},
  })),
}));

describe("runHarness - success path", () => {
  test("completes successfully when evaluator passes on first iteration", async () => {
    evalCallCount = 0;
    evalShouldPass = true;
    evalPassFromCallN = 1;

    const tmpDesignFile = `/tmp/harness-design-${Date.now()}.md`;
    const tmpPlanFile = `/tmp/harness-plan-${Date.now()}.md`;
    const tmpOutputDir = `/tmp/harness-output-${Date.now()}`;
    trackedFiles.push(tmpDesignFile, tmpPlanFile, tmpOutputDir);
    await Bun.write(tmpDesignFile, "# Design doc");

    const { runHarness } = await import("../pipeline/harness.ts");

    const report = await runHarness({
      maxEvaluatorIterations: 3, maxToolCallIterations: 20,
      commandTimeoutSecs: 120, llmTimeoutSecs: 300,
      outputDir: tmpOutputDir,
      appDir: tmpOutputDir + "/app",
      designFile: tmpDesignFile,
      planFile: tmpPlanFile,
      memoryFile: tmpOutputDir + "/memory.md",
      devServer: { port: 3000, startCommand: "bun run dev" },
      playwright: { headless: true, browser: "chrome" },
      provider: { type: "copilot" },

      agents: {
        taskAgent: { model: "gpt-4o", systemPrompt: "You are an architect." },
        implementationCoordinator: { model: "gpt-4.1", systemPrompt: "You are a coordinator." },
        implementationAgent: { model: "gpt-4o", systemPrompt: "You are a coder." },
        evaluatorAgent: { model: "gpt-4o", systemPrompt: "You are an evaluator." },
      },
    });

    expect(report.result).toBe("SUCCESS");
    expect(report.totalIterations).toBe(1);
    expect(report.steps).toHaveLength(3);
  });
});

describe("runHarness - max iterations failure", () => {
  test("terminates with FAILURE when max iterations reached", async () => {
    evalCallCount = 0;
    evalShouldPass = false;
    evalPassFromCallN = 1;

    const tmpDesignFile = `/tmp/harness-design-${Date.now()}.md`;
    const tmpPlanFile = `/tmp/harness-plan-${Date.now()}.md`;
    const tmpOutputDir = `/tmp/harness-output-${Date.now()}`;
    trackedFiles.push(tmpDesignFile, tmpPlanFile, tmpOutputDir);
    await Bun.write(tmpDesignFile, "# Design doc");

    const { runHarness } = await import("../pipeline/harness.ts");

    const report = await runHarness({
      maxEvaluatorIterations: 2, maxToolCallIterations: 20,
      commandTimeoutSecs: 120, llmTimeoutSecs: 300,
      outputDir: tmpOutputDir,
      appDir: tmpOutputDir + "/app",
      designFile: tmpDesignFile,
      planFile: tmpPlanFile,
      memoryFile: tmpOutputDir + "/memory.md",
      devServer: { port: 3001, startCommand: "bun run dev" },
      playwright: { headless: true, browser: "chrome" },
      provider: { type: "copilot" },

      agents: {
        taskAgent: { model: "gpt-4o", systemPrompt: "You are an architect." },
        implementationCoordinator: { model: "gpt-4.1", systemPrompt: "You are a coordinator." },
        implementationAgent: { model: "gpt-4o", systemPrompt: "You are a coder." },
        evaluatorAgent: { model: "gpt-4o", systemPrompt: "You are an evaluator." },
      },
    });

    expect(report.result).toBe("FAILURE");
    expect(report.totalIterations).toBe(2);
  });
});

describe("runHarness - missing design file", () => {
  test("throws when design file does not exist", async () => {
    const { runHarness } = await import("../pipeline/harness.ts");

    expect(
      runHarness({
        maxEvaluatorIterations: 3, maxToolCallIterations: 20,
        commandTimeoutSecs: 120, llmTimeoutSecs: 300,
        outputDir: "/tmp/output",
        appDir: "/tmp/output/app",
        designFile: "/tmp/nonexistent-design-xyz.md",
        planFile: "/tmp/plan.md",
        memoryFile: "/tmp/memory.md",
        devServer: { port: 3000, startCommand: "bun run dev" },
        playwright: { headless: true, browser: "chrome" },
        provider: { type: "copilot" },

        agents: {
          taskAgent: { model: "gpt-4o", systemPrompt: "You are an architect." },
          implementationCoordinator: { model: "gpt-4.1", systemPrompt: "You are a coordinator." },
          implementationAgent: { model: "gpt-4o", systemPrompt: "You are a coder." },
          evaluatorAgent: { model: "gpt-4o", systemPrompt: "You are an evaluator." },
        },
      }),
    ).rejects.toThrow("Design file not found");
  });
});

describe("runHarness - startup resume from existing plan.md", () => {
  test("skips task agent and resumes from first pending task when plan.md exists", async () => {
    evalCallCount = 0;
    evalShouldPass = true;
    evalPassFromCallN = 1;

    const tmpDesignFile = `/tmp/harness-design-resume-${Date.now()}.md`;
    const tmpOutputDir = `/tmp/harness-output-resume-${Date.now()}`;
    const tmpAppDir = `${tmpOutputDir}/app`;
    const tmpPlanFile = `${tmpOutputDir}/plan.md`;
    const tmpMemoryFile = `${tmpOutputDir}/memory.md`;
    trackedFiles.push(tmpDesignFile, tmpOutputDir);

    await Bun.write(tmpDesignFile, "# Design doc");
    await fs.mkdir(tmpOutputDir, { recursive: true });

    // Pre-write a plan.md so the harness should resume (skip task agent)
    await Bun.write(
      tmpPlanFile,
      `### Task 1: Build app
**Status**: pending
**Description**: Create the app
**Acceptance Criteria**: App runs
**Example Code**:
\`\`\`typescript
console.log("hello");
\`\`\`
`,
    );

    // Pre-populate appDir with a marker file — it should NOT be cleared on resume
    await fs.mkdir(tmpAppDir, { recursive: true });
    await Bun.write(`${tmpAppDir}/marker.txt`, "should survive resume");

    const { runTaskAgent: mockTaskAgent } = await import("../agents/task-agent.ts");
    const taskAgentMock = mockTaskAgent as ReturnType<typeof mock>;
    taskAgentMock.mockClear();

    const { runHarness } = await import("../pipeline/harness.ts");

    const report = await runHarness({
      maxEvaluatorIterations: 3,
      maxToolCallIterations: 20,
      commandTimeoutSecs: 120,
      llmTimeoutSecs: 300,
      outputDir: tmpOutputDir,
      appDir: tmpAppDir,
      designFile: tmpDesignFile,
      planFile: tmpPlanFile,
      memoryFile: tmpMemoryFile,
      devServer: { port: 3003, startCommand: "bun run dev" },
      playwright: { headless: true, browser: "chrome" },
      provider: { type: "copilot" },

      agents: {
        taskAgent: { model: "gpt-4o", systemPrompt: "You are an architect." },
        implementationCoordinator: { model: "gpt-4.1", systemPrompt: "You are a coordinator." },
        implementationAgent: { model: "gpt-4o", systemPrompt: "You are a coder." },
        evaluatorAgent: { model: "gpt-4o", systemPrompt: "You are an evaluator." },
      },
    });

    expect(report.result).toBe("SUCCESS");
    // Task agent should NOT have been called (we resumed from existing plan.md)
    expect(taskAgentMock.mock.calls.length).toBe(0);
    // appDir should be untouched
    expect(await Bun.file(`${tmpAppDir}/marker.txt`).exists()).toBe(true);
  });

  test("clears output dir and runs task agent when plan.md does not exist", async () => {
    evalCallCount = 0;
    evalShouldPass = true;
    evalPassFromCallN = 1;

    const tmpDesignFile = `/tmp/harness-design-fresh-${Date.now()}.md`;
    const tmpOutputDir = `/tmp/harness-output-fresh-${Date.now()}`;
    const tmpAppDir = `${tmpOutputDir}/app`;
    const tmpPlanFile = `${tmpOutputDir}/plan.md`;
    const tmpMemoryFile = `${tmpOutputDir}/memory.md`;
    trackedFiles.push(tmpDesignFile, tmpOutputDir);

    await Bun.write(tmpDesignFile, "# Design doc");

    // Pre-populate outputDir with a stale marker — it should be cleared on fresh start
    await fs.mkdir(tmpAppDir, { recursive: true });
    await Bun.write(`${tmpAppDir}/stale.txt`, "should be deleted");

    // No plan.md — harness must start fresh

    const { runTaskAgent: mockTaskAgent } = await import("../agents/task-agent.ts");
    const taskAgentMock = mockTaskAgent as ReturnType<typeof mock>;
    taskAgentMock.mockClear();

    const { runHarness } = await import("../pipeline/harness.ts");

    const report = await runHarness({
      maxEvaluatorIterations: 3,
      maxToolCallIterations: 20,
      commandTimeoutSecs: 120,
      llmTimeoutSecs: 300,
      outputDir: tmpOutputDir,
      appDir: tmpAppDir,
      designFile: tmpDesignFile,
      planFile: tmpPlanFile,
      memoryFile: tmpMemoryFile,
      devServer: { port: 3004, startCommand: "bun run dev" },
      playwright: { headless: true, browser: "chrome" },
      provider: { type: "copilot" },

      agents: {
        taskAgent: { model: "gpt-4o", systemPrompt: "You are an architect." },
        implementationCoordinator: { model: "gpt-4.1", systemPrompt: "You are a coordinator." },
        implementationAgent: { model: "gpt-4o", systemPrompt: "You are a coder." },
        evaluatorAgent: { model: "gpt-4o", systemPrompt: "You are an evaluator." },
      },
    });

    expect(report.result).toBe("SUCCESS");
    // Task agent should have been called once (fresh start)
    expect(taskAgentMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    // Stale file should have been cleared
    expect(await Bun.file(`${tmpAppDir}/stale.txt`).exists()).toBe(false);
  });
});

describe("runHarness - permanently failed task", () => {
  test("does not call evaluator and reports FAILURE when a task permanently fails", async () => {
    evalCallCount = 0;
    evalShouldPass = true;

    // Simulate the coordinator returning a permanently failed task
    coordResult = {
      tasksCompleted: 0,
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, llmCallCount: 2 },
      permanentlyFailedTask: { number: 3, title: "Build the widget" },
    };

    const tmpDesignFile = `/tmp/harness-design-pfail-${Date.now()}.md`;
    const tmpPlanFile = `/tmp/harness-plan-pfail-${Date.now()}.md`;
    const tmpOutputDir = `/tmp/harness-output-pfail-${Date.now()}`;
    trackedFiles.push(tmpDesignFile, tmpPlanFile, tmpOutputDir);
    await Bun.write(tmpDesignFile, "# Design doc");

    const { runHarness } = await import("../pipeline/harness.ts");

    const report = await runHarness({
      maxEvaluatorIterations: 3,
      maxToolCallIterations: 20,
      commandTimeoutSecs: 120,
      llmTimeoutSecs: 300,
      maxTaskRetries: 2,
      outputDir: tmpOutputDir,
      appDir: tmpOutputDir + "/app",
      designFile: tmpDesignFile,
      planFile: tmpPlanFile,
      memoryFile: tmpOutputDir + "/memory.md",
      devServer: { port: 3005, startCommand: "bun run dev" },
      playwright: { headless: true, browser: "chrome" },
      provider: { type: "copilot" },

      agents: {
        taskAgent: { model: "gpt-4o", systemPrompt: "You are an architect." },
        implementationCoordinator: { model: "gpt-4.1", systemPrompt: "You are a coordinator." },
        implementationAgent: { model: "gpt-4o", systemPrompt: "You are a coder." },
        evaluatorAgent: { model: "gpt-4o", systemPrompt: "You are an evaluator." },
      },
    });

    // Pipeline must report failure
    expect(report.result).toBe("FAILURE");
    expect(report.resultReason).toContain("Build the widget");
    expect(report.resultReason).toContain("permanently failed");

    // Evaluator must NOT have been called — the pipeline should abort before reaching it
    expect(evalCallCount).toBe(0);
  });
});

describe("runHarness - re-run resets incomplete tasks", () => {
  test("resets failed and pending tasks to pending in task-number order on re-run", async () => {
    evalCallCount = 0;
    evalShouldPass = true;
    evalPassFromCallN = 1;

    const tmpDesignFile = `/tmp/harness-design-rerun-${Date.now()}.md`;
    const tmpOutputDir = `/tmp/harness-output-rerun-${Date.now()}`;
    const tmpAppDir = `${tmpOutputDir}/app`;
    const tmpPlanFile = `${tmpOutputDir}/plan.md`;
    const tmpMemoryFile = `${tmpOutputDir}/memory.md`;
    trackedFiles.push(tmpDesignFile, tmpOutputDir);

    await Bun.write(tmpDesignFile, "# Design doc");
    await fs.mkdir(tmpOutputDir, { recursive: true });

    // Pre-write a plan.md with mixed statuses — task 2 completed, task 3 failed, task 4 pending
    await Bun.write(
      tmpPlanFile,
      `### Task 2: First task
**Status**: completed
**Description**: Already done
**Acceptance Criteria**: Done
**Example Code**:
\`\`\`typescript
// done
\`\`\`

### Task 3: Widget builder
**Status**: failed
**Description**: Build the widget
**Acceptance Criteria**: Widget exists
**Example Code**:
\`\`\`typescript
// widget
\`\`\`

### Task 4: Final task
**Status**: pending
**Description**: Finish it up
**Acceptance Criteria**: All done
**Example Code**:
\`\`\`typescript
// finish
\`\`\`
`,
    );

    const { runTaskAgent: mockTaskAgent } = await import("../agents/task-agent.ts");
    const taskAgentMock = mockTaskAgent as ReturnType<typeof mock>;
    taskAgentMock.mockClear();

    const { runHarness } = await import("../pipeline/harness.ts");

    const report = await runHarness({
      maxEvaluatorIterations: 3,
      maxToolCallIterations: 20,
      commandTimeoutSecs: 120,
      llmTimeoutSecs: 300,
      outputDir: tmpOutputDir,
      appDir: tmpAppDir,
      designFile: tmpDesignFile,
      planFile: tmpPlanFile,
      memoryFile: tmpMemoryFile,
      devServer: { port: 3006, startCommand: "bun run dev" },
      playwright: { headless: true, browser: "chrome" },
      provider: { type: "copilot" },

      agents: {
        taskAgent: { model: "gpt-4o", systemPrompt: "You are an architect." },
        implementationCoordinator: { model: "gpt-4.1", systemPrompt: "You are a coordinator." },
        implementationAgent: { model: "gpt-4o", systemPrompt: "You are a coder." },
        evaluatorAgent: { model: "gpt-4o", systemPrompt: "You are an evaluator." },
      },
    });

    expect(report.result).toBe("SUCCESS");
    // Task agent must NOT have been called — we resumed from existing plan.md
    expect(taskAgentMock.mock.calls.length).toBe(0);

    // Completed task must remain completed; failed and pending must be reset to pending
    const planContent = await Bun.file(tmpPlanFile).text();
    expect(planContent).toMatch(/### Task 2:.*\n\*\*Status\*\*: completed/s);
    expect(planContent).toMatch(/### Task 3:.*\n\*\*Status\*\*: pending/s);
    expect(planContent).toMatch(/### Task 4:.*\n\*\*Status\*\*: pending/s);
  });
});
