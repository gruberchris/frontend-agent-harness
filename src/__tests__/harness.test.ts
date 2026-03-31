import { describe, test, expect, mock, afterEach } from "bun:test";
import * as fs from "node:fs/promises";

const trackedFiles: string[] = [];

afterEach(async () => {
  for (const f of trackedFiles) {
    await fs.rm(f, { force: true, recursive: true }).catch(() => {});
  }
  trackedFiles.length = 0;
});

// Full pipeline harness integration tests with all agents mocked

mock.module("../agents/task-agent.ts", () => ({
  runTaskAgent: mock(async (_model: string, _design: string, planFile: string) => {
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
      usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
    };
  }),
}));

mock.module("../agents/implementation-coordinator.ts", () => ({
  runImplementationCoordinator: mock(async () => ({
    tasksCompleted: 1,
    usage: { promptTokens: 500, completionTokens: 1000, totalTokens: 1500 },
  })),
}));

let evalCallCount = 0;
let evalShouldPass = true;

mock.module("../agents/evaluator-agent.ts", () => ({
  runEvaluatorAgent: mock(async () => {
    evalCallCount++;
    if (evalShouldPass) {
      return {
        decision: "PASS",
        explanation: "All good",
        usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
      };
    }
    return {
      decision: "NEEDS_WORK",
      explanation: "Issues found",
      usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
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

    const tmpDesignFile = `/tmp/harness-design-${Date.now()}.md`;
    const tmpPlanFile = `/tmp/harness-plan-${Date.now()}.md`;
    const tmpOutputDir = `/tmp/harness-output-${Date.now()}`;
    trackedFiles.push(tmpDesignFile, tmpPlanFile, tmpOutputDir);
    await Bun.write(tmpDesignFile, "# Design doc");

    const { runHarness } = await import("../pipeline/harness.ts");

    const report = await runHarness({
      maxEvaluatorIterations: 3, maxToolCallIterations: 20,
      outputDir: tmpOutputDir,
      designFile: tmpDesignFile,
      planFile: tmpPlanFile,
      devServer: { port: 3000, startCommand: "bun run dev" },
      playwright: { headless: true, browser: "chrome" },
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

    const tmpDesignFile = `/tmp/harness-design-${Date.now()}.md`;
    const tmpPlanFile = `/tmp/harness-plan-${Date.now()}.md`;
    const tmpOutputDir = `/tmp/harness-output-${Date.now()}`;
    trackedFiles.push(tmpDesignFile, tmpPlanFile, tmpOutputDir);
    await Bun.write(tmpDesignFile, "# Design doc");

    const { runHarness } = await import("../pipeline/harness.ts");

    const report = await runHarness({
      maxEvaluatorIterations: 2, maxToolCallIterations: 20,
      outputDir: tmpOutputDir,
      designFile: tmpDesignFile,
      planFile: tmpPlanFile,
      devServer: { port: 3001, startCommand: "bun run dev" },
      playwright: { headless: true, browser: "chrome" },
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
        outputDir: "/tmp/output",
        designFile: "/tmp/nonexistent-design-xyz.md",
        planFile: "/tmp/plan.md",
        devServer: { port: 3000, startCommand: "bun run dev" },
        playwright: { headless: true, browser: "chrome" },
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
