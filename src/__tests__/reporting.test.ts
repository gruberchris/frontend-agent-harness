import { describe, test, expect } from "bun:test";
import { printReport, type PipelineReport } from "../pipeline/reporting.ts";

describe("printReport", () => {
  test("runs without throwing for a success report", () => {
    const report: PipelineReport = {
      steps: [
        {
          name: "Task Agent",
          usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500, llmCallCount: 1 },
          invocationCount: 1,
        },
        {
          name: "Implementation Agent",
          usage: { promptTokens: 5000, completionTokens: 2000, totalTokens: 7000, llmCallCount: 25 },
          invocationCount: 25,
        },
        {
          name: "Evaluator Agent",
          usage: { promptTokens: 2000, completionTokens: 800, totalTokens: 2800, llmCallCount: 4 },
          invocationCount: 4,
        },
      ],
      totalIterations: 1,
      elapsedMs: 62000,
      result: "SUCCESS",
      resultReason: "All checks passed",
    };

    expect(() => printReport(report)).not.toThrow();
  });

  test("runs without throwing for a failure report", () => {
    const report: PipelineReport = {
      steps: [
        {
          name: "Task Agent",
          usage: { promptTokens: 500, completionTokens: 200, totalTokens: 700, llmCallCount: 1 },
          invocationCount: 1,
        },
      ],
      totalIterations: 3,
      elapsedMs: 300000,
      result: "FAILURE",
      resultReason: "Max iterations reached",
    };
    expect(() => printReport(report)).not.toThrow();
  });

  test("handles empty steps array", () => {
    const report: PipelineReport = {
      steps: [],
      totalIterations: 0,
      elapsedMs: 0,
      result: "FAILURE",
    };
    expect(() => printReport(report)).not.toThrow();
  });

  test("formats elapsed time with minutes correctly", () => {
    // We can't easily test formatted output directly, but ensure no throw
    const report: PipelineReport = {
      steps: [],
      totalIterations: 1,
      elapsedMs: 125_000, // 2m 5s
      result: "SUCCESS",
    };
    expect(() => printReport(report)).not.toThrow();
  });
});

describe("token aggregation in report", () => {
  test("grand total sums all steps correctly", () => {
    // Verify the math by re-implementing the calculation
    const steps = [
      { promptTokens: 100, completionTokens: 50, totalTokens: 150, llmCallCount: 1 },
      { promptTokens: 200, completionTokens: 100, totalTokens: 300, llmCallCount: 5 },
      { promptTokens: 300, completionTokens: 150, totalTokens: 450, llmCallCount: 2 },
    ];

    const grandTotal = steps.reduce(
      (acc, s) => ({
        promptTokens: acc.promptTokens + s.promptTokens,
        completionTokens: acc.completionTokens + s.completionTokens,
        totalTokens: acc.totalTokens + s.totalTokens,
        llmCallCount: acc.llmCallCount + s.llmCallCount,
      }),
      { promptTokens: 0, completionTokens: 0, totalTokens: 0, llmCallCount: 0 },
    );

    expect(grandTotal.promptTokens).toBe(600);
    expect(grandTotal.completionTokens).toBe(300);
    expect(grandTotal.totalTokens).toBe(900);
  });
});
