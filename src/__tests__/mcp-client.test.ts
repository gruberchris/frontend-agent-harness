import { describe, test, expect } from "bun:test";

// PlaywrightMcpServer → McpClient cwd wiring is verified in evaluator-agent.test.ts
// (capturedMcpOutputDir check). These tests cover McpClient's own cwd storage,
// which is not mocked by any other test file.

describe("McpClient constructor", () => {
  test("stores cwd for use in Bun.spawn", async () => {
    const { McpClient } = await import("../mcp/mcp-client.ts");
    const client = new McpClient(["bunx", "playwright-mcp"], "/tmp/test-cwd");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).cwd).toBe("/tmp/test-cwd");
  });

  test("cwd is undefined when not provided", async () => {
    const { McpClient } = await import("../mcp/mcp-client.ts");
    const client = new McpClient(["bunx", "playwright-mcp"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).cwd).toBeUndefined();
  });

  test("stores command for use in Bun.spawn", async () => {
    const { McpClient } = await import("../mcp/mcp-client.ts");
    const cmd = ["bunx", "playwright-mcp", "--browser", "chrome"];
    const client = new McpClient(cmd);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).command).toEqual(cmd);
  });
});
