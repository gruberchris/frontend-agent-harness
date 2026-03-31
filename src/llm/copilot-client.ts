import OpenAI from "openai";
import type { LLMMessage, LLMResponse, ToolDefinition, TokenUsage } from "./types.ts";

async function resolveToken(): Promise<string> {
  const envToken = process.env["GITHUB_TOKEN"];
  if (envToken) return envToken;

  // Fall back to `gh auth token` (GitHub CLI) if no env var is set
  try {
    const result = await Bun.$`gh auth token`.quiet();
    const token = result.stdout.toString().trim();
    if (token) return token;
  } catch {
    // gh not installed or not authenticated — fall through to error
  }

  throw new Error(
    "No GitHub token found. Set GITHUB_TOKEN in .env or run `gh auth login` to authenticate via the GitHub CLI.\n" +
    "Note: Personal Access Tokens (PATs) are not supported — the Copilot API requires an OAuth token.\n" +
    "Get one with: gh auth login  (then the harness will pick it up automatically)"
  );
}

export class CopilotClient {
  private client!: OpenAI;
  private model: string;
  private reasoningEffort?: string;
  private maxTokens?: number;

  constructor(model: string, reasoningEffort?: string, maxTokens?: number) {
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.maxTokens = maxTokens;
  }

  async init(): Promise<void> {
    const token = await resolveToken();
    this.client = new OpenAI({
      apiKey: token,
      baseURL: "https://api.githubcopilot.com",
    });
  }

  async chat(
    messages: LLMMessage[],
    tools?: ToolDefinition[],
  ): Promise<LLMResponse> {
    if (!this.client) await this.init();
    const openaiMessages = messages.map((m) => {
      let content: string | any[] = "";
      if (Array.isArray(m.content)) {
        content = m.content.map((part) => {
          if (part.type === "text") {
            return { type: "text", text: part.text };
          } else {
            return {
              type: "image_url",
              image_url: {
                url: `data:${part.mimeType};base64,${part.data}`,
              },
            };
          }
        });
      } else {
        content = m.content ?? "";
      }

      if (m.role === "tool") {
        return {
          role: "tool" as const,
          content: typeof content === "string" ? content : JSON.stringify(content),
          tool_call_id: m.toolCallId ?? "",
        };
      }
      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        return {
          role: "assistant" as const,
          content: typeof content === "string" ? content : null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        };
      }
      return {
        role: m.role as "system" | "user" | "assistant",
        content: content as any,
      };
    });

    const openaiTools = tools?.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: openaiMessages,
      tools: openaiTools,
      tool_choice: openaiTools ? "auto" : undefined,
      ...(this.reasoningEffort && { reasoning_effort: this.reasoningEffort as "low" | "medium" | "high" }),
      ...(this.maxTokens && { max_tokens: this.maxTokens }),
    });

    const choice = response.choices[0];
    if (!choice) {
      const finishReason = (response as { finish_reason?: string }).finish_reason;
      throw new Error(
        `LLM returned no choices (model: ${this.model}, finish_reason: ${finishReason ?? "none"}).` +
        ` This usually means the context window was exceeded or the request was filtered.`
      );
    }

    const toolCalls = (choice.message.tool_calls ?? []).map((tc) => {
      // OpenAI SDK types tool_calls with a union; both shapes have function
      const fn = (tc as { function: { name: string; arguments: string } }).function;
      return {
        id: tc.id,
        name: fn.name,
        arguments: (() => {
          try {
            return JSON.parse(fn.arguments) as Record<string, unknown>;
          } catch {
            return {};
          }
        })(),
      };
    });

    const usage: TokenUsage = {
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      totalTokens: response.usage?.total_tokens ?? 0,
    };

    return {
      content: choice.message.content ?? null,
      toolCalls,
      usage,
      finishReason: (choice.finish_reason as LLMResponse["finishReason"]) ?? "stop",
    };
  }
}
