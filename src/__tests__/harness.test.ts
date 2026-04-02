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
let evalPassFromCallN = 1; // pass starting from this call number (1-indexed); default = always pass

mock.module("../agents/evaluator-agent.ts", () => ({
  runEvaluatorAgent: mock(async () => {
    evalCallCount++;
    if (evalShouldPass && evalCallCount >= evalPassFromCallN) {
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
    evalPassFromCallN = 1;

    const tmpDesignFile = `/tmp/harness-design-${Date.now()}.md`;
    const tmpPlanFile = `/tmp/harness-plan-${Date.now()}.md`;
    const tmpOutputDir = `/tmp/harness-output-${Date.now()}`;
    trackedFiles.push(tmpDesignFile, tmpPlanFile, tmpOutputDir);
    await Bun.write(tmpDesignFile, "# Design doc");

    const { runHarness } = await import("../pipeline/harness.ts");

    const report = await runHarness({
      maxEvaluatorIterations: 3, maxToolCallIterations: 20,
      outputDir: tmpOutputDir,
      appDir: tmpOutputDir + "/app",
      designFile: tmpDesignFile,
      planFile: tmpPlanFile,
      memoryFile: tmpOutputDir + "/memory.md",
      resetAppOnRetry: false,
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
      outputDir: tmpOutputDir,
      appDir: tmpOutputDir + "/app",
      designFile: tmpDesignFile,
      planFile: tmpPlanFile,
      memoryFile: tmpOutputDir + "/memory.md",
      resetAppOnRetry: false,
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
        outputDir: "/tmp/output",
        appDir: "/tmp/output/app",
        designFile: "/tmp/nonexistent-design-xyz.md",
        planFile: "/tmp/plan.md",
        resetAppOnRetry: false,
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

describe("runHarness - resetAppOnRetry", () => {
  test("clears appDir and resets planFile on retry but preserves memoryFile and rest of outputDir", async () => {
    evalCallCount = 0;
    evalShouldPass = true;
    evalPassFromCallN = 2; // fail on call 1, pass on call 2

    const tmpDesignFile = `/tmp/harness-design-reset-${Date.now()}.md`;
    const tmpOutputDir = `/tmp/harness-output-reset-${Date.now()}`;
    const tmpAppDir = `${tmpOutputDir}/app`;
    const tmpPlanFile = `${tmpOutputDir}/plan.md`;
    const tmpMemoryFile = `${tmpOutputDir}/memory.md`;
    trackedFiles.push(tmpDesignFile, tmpOutputDir);

    await Bun.write(tmpDesignFile, "# Design doc");

    // Pre-populate appDir with a marker file (simulates first iteration output)
    await fs.mkdir(tmpAppDir, { recursive: true });
    await Bun.write(`${tmpAppDir}/marker.txt`, "should be deleted on retry");

    // Put a file in outputDir but OUTSIDE appDir (should survive)
    await Bun.write(`${tmpOutputDir}/outside.txt`, "should survive retry");

    // Pre-write memory file with existing content (should survive)
    await Bun.write(tmpMemoryFile, "prior memory content");

    const { runHarness } = await import("../pipeline/harness.ts");

    const report = await runHarness({
      maxEvaluatorIterations: 3,
      maxToolCallIterations: 20,
      outputDir: tmpOutputDir,
      appDir: tmpAppDir,
      designFile: tmpDesignFile,
      planFile: tmpPlanFile,
      memoryFile: tmpMemoryFile,
      resetAppOnRetry: true,
      devServer: { port: 3002, startCommand: "bun run dev" },
      playwright: { headless: true, browser: "chrome" },
      provider: { type: "copilot" },

      agents: {
        taskAgent: { model: "gpt-4o", systemPrompt: "You are an architect." },
        implementationCoordinator: { model: "gpt-4.1", systemPrompt: "You are a coordinator." },
        implementationAgent: { model: "gpt-4o", systemPrompt: "You are a coder." },
        evaluatorAgent: { model: "gpt-4o", systemPrompt: "You are an evaluator." },
      },
    });

    // Two iterations: NEEDS_WORK on first, PASS on second
    expect(report.totalIterations).toBe(2);
    expect(report.result).toBe("SUCCESS");

    // appDir marker should have been cleared on retry
    expect(await Bun.file(`${tmpAppDir}/marker.txt`).exists()).toBe(false);

    // File outside appDir in outputDir should be untouched
    expect(await Bun.file(`${tmpOutputDir}/outside.txt`).exists()).toBe(true);
    expect(await Bun.file(`${tmpOutputDir}/outside.txt`).text()).toBe("should survive retry");

    // memoryFile should be preserved (not cleared by retry)
    expect(await Bun.file(tmpMemoryFile).text()).toBe("prior memory content");
  });
});
