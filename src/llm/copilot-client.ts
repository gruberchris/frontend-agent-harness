import OpenAI from "openai";
import type { LLMMessage, LLMResponse, ToolDefinition, TokenUsage } from "./types.ts";

export class CopilotClient {
  private client: OpenAI;
  private model: string;
  private reasoningEffort?: string;

  constructor(model: string, reasoningEffort?: string) {
    const token = process.env["GITHUB_TOKEN"];
    if (!token) {
      throw new Error("GITHUB_TOKEN environment variable is required");
    }
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.client = new OpenAI({
      apiKey: token,
      baseURL: "https://api.githubcopilot.com",
    });
  }

  async chat(
    messages: LLMMessage[],
    tools?: ToolDefinition[],
  ): Promise<LLMResponse> {
    const openaiMessages = messages.map((m) => {
      if (m.role === "tool") {
        return {
          role: "tool" as const,
          content: m.content ?? "",
          tool_call_id: m.toolCallId ?? "",
        };
      }
      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        return {
          role: "assistant" as const,
          content: m.content,
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
        content: m.content ?? "",
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
    });

    const choice = response.choices[0];
    if (!choice) throw new Error("No choices in LLM response");

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
