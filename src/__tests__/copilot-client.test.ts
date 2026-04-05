import { describe, test, expect } from "bun:test";
import { addTokenUsage, emptyTokenUsage } from "../llm/types.ts";

describe("emptyTokenUsage", () => {
  test("returns all zeros", () => {
    const usage = emptyTokenUsage();
    expect(usage.promptTokens).toBe(0);
    expect(usage.completionTokens).toBe(0);
    expect(usage.totalTokens).toBe(0);
    expect(usage.llmCallCount).toBe(0);
  });
});

describe("addTokenUsage", () => {
  test("adds two token usages correctly", () => {
    const a = { promptTokens: 100, completionTokens: 50, totalTokens: 150, llmCallCount: 1 };
    const b = { promptTokens: 200, completionTokens: 75, totalTokens: 275, llmCallCount: 1 };
    const result = addTokenUsage(a, b);
    expect(result.promptTokens).toBe(300);
    expect(result.completionTokens).toBe(125);
    expect(result.totalTokens).toBe(425);
    expect(result.llmCallCount).toBe(2);
  });

  test("adds zero usages", () => {
    const a = { promptTokens: 100, completionTokens: 50, totalTokens: 150, llmCallCount: 1 };
    const zero = emptyTokenUsage();
    const result = addTokenUsage(a, zero);
    expect(result).toEqual(a);
  });

  test("is associative", () => {
    const a = { promptTokens: 10, completionTokens: 20, totalTokens: 30, llmCallCount: 1 };
    const b = { promptTokens: 40, completionTokens: 50, totalTokens: 90, llmCallCount: 2 };
    const c = { promptTokens: 100, completionTokens: 200, totalTokens: 300, llmCallCount: 3 };
    const ab_c = addTokenUsage(addTokenUsage(a, b), c);
    const a_bc = addTokenUsage(a, addTokenUsage(b, c));
    expect(ab_c).toEqual(a_bc);
  });
});
