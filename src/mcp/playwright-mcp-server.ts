import { McpClient, type McpTool, type McpToolResult } from "./mcp-client.ts";

export class PlaywrightMcpServer {
  private client: McpClient | null = null;

  constructor(
    private readonly browser: string = "chrome",
    private readonly headless: boolean = true,
    private readonly outputDir?: string,
  ) {}

  async start(): Promise<McpTool[]> {
    const args = [
      "playwright-mcp",
      "--browser",
      this.browser,
    ];
    if (this.headless) args.push("--headless");

    this.client = new McpClient(["bunx", ...args], this.outputDir);
    await this.client.start();
    return this.client.listTools();
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (!this.client) throw new Error("Playwright MCP server not started");
    return this.client.callTool(name, args);
  }

  async stop(): Promise<void> {
    await this.client?.stop();
    this.client = null;
  }
}
