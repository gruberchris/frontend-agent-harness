export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export class McpClient {
  private subprocess: ReturnType<typeof Bun.spawn> | null = null;
  private nextId = 1;
  private pendingRequests = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private buffer = "";

  constructor(private readonly command: string[]) {}

  async start(): Promise<void> {
    this.subprocess = Bun.spawn(this.command, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    this.readLoop();

    await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "frontend-agent-harness", version: "1.0.0" },
    });

    await this.send("notifications/initialized", null);
  }

  private readLoop(): void {
    const reader = this.subprocess!.stdout;
    const self = this;

    (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of reader as AsyncIterable<Uint8Array>) {
        self.buffer += decoder.decode(chunk);
        self.processBuffer();
      }
    })().catch(() => {});
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse;
        if (msg.id !== undefined) {
          const pending = this.pendingRequests.get(msg.id);
          if (pending) {
            this.pendingRequests.delete(msg.id);
            if (msg.error) {
              pending.reject(new Error(msg.error.message));
            } else {
              pending.resolve(msg.result);
            }
          }
        }
      } catch {
        // ignore non-JSON lines
      }
    }
  }

  private send(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pendingRequests.set(id, { resolve, reject });
      const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
      const line = JSON.stringify(request) + "\n";
      const stdin = this.subprocess!.stdin as import("bun").FileSink;
      stdin.write(new TextEncoder().encode(line));
    });
  }

  async listTools(): Promise<McpTool[]> {
    const result = (await this.send("tools/list", {})) as { tools: McpTool[] };
    return result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    return (await this.send("tools/call", {
      name,
      arguments: args,
    })) as McpToolResult;
  }

  async stop(): Promise<void> {
    if (this.subprocess) {
      this.subprocess.kill();
      this.subprocess = null;
    }
    this.pendingRequests.forEach(({ reject }) => reject(new Error("MCP client stopped")));
    this.pendingRequests.clear();
  }
}
