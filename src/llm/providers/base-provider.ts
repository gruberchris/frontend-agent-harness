import OpenAI from "openai";
import type { LLMMessage, LLMResponse, ToolDefinition, TokenUsage } from "../types.ts";
import type { LLMProvider } from "../provider.ts";

/**
 * Base class for all OpenAI-compatible providers (Copilot, Azure OpenAI, Ollama).
 * Subclasses implement `initClient()` to set up the OpenAI-compatible client,
 * and may override `supportsReasoningEffort` to control whether `reasoning_effort`
 * is forwarded in requests.
 */
export abstract class OpenAICompatibleProvider implements LLMProvider {
  protected client!: OpenAI;
  protected model: string;
  protected reasoningEffort?: string;
  protected maxTokens?: number;
  protected llmTimeoutMs?: number;
  protected readonly supportsReasoningEffort: boolean = true;
  /** Parameter name for the token limit. Subclasses may override to "max_completion_tokens". */
  protected readonly maxTokensParamName: string = "max_tokens";

  protected parallelToolCalls?: boolean;
  protected frequencyPenalty?: number;

  constructor(model: string, reasoningEffort?: string, maxTokens?: number, llmTimeoutSecs?: number, parallelToolCalls?: boolean, frequencyPenalty?: number) {
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.maxTokens = maxTokens;
    this.llmTimeoutMs = llmTimeoutSecs !== undefined ? llmTimeoutSecs * 1000 : undefined;
    this.parallelToolCalls = parallelToolCalls;
    this.frequencyPenalty = frequencyPenalty;
  }

  protected abstract initClient(): Promise<void>;

  async chat(messages: LLMMessage[], tools?: ToolDefinition[]): Promise<LLMResponse> {
    if (!this.client) await this.initClient();

    const openaiMessages = messages.map((m) => {
      let content: string | unknown[];
      if (Array.isArray(m.content)) {
        content = m.content.map((part) => {
          if (part.type === "text") {
            return { type: "text", text: part.text };
          } else {
            return {
              type: "image_url",
              image_url: { url: `data:${part.mimeType};base64,${part.data}` },
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
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        };
      }
      return {
        role: m.role as "system" | "user" | "assistant",
        content: content as string,
      };
    });

    const openaiTools = tools?.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    // Spinner while waiting for LLM — only in interactive terminals.
    // Uses \r to overwrite in place; cleared completely when the response arrives
    // so it leaves no trace in the scrollback.
    const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let frameIdx = 0;
    const tickerStart = Date.now();
    let ticker: ReturnType<typeof setInterval> | undefined;
    if (process.stdout.isTTY) {
      const spin = () => {
        const elapsed = Math.round((Date.now() - tickerStart) / 1000);
        const frame = FRAMES[frameIdx++ % FRAMES.length];
        process.stdout.write(`\r    ${frame} 🤔 ${elapsed}s `);
      };
      spin();
      ticker = setInterval(spin, 100);
    }

    let response: Awaited<ReturnType<typeof this.client.chat.completions.create>>;
    try {
      response = await this.client.chat.completions.create({
        model: this.model,
        messages: openaiMessages as Parameters<typeof this.client.chat.completions.create>[0]["messages"],
        tools: openaiTools,
        tool_choice: openaiTools ? "auto" : undefined,
        ...(this.parallelToolCalls === false && { parallel_tool_calls: false }),
        ...(this.frequencyPenalty !== undefined && { frequency_penalty: this.frequencyPenalty }),
        ...(this.supportsReasoningEffort && this.reasoningEffort && {
          reasoning_effort: this.reasoningEffort as "low" | "medium" | "high",
        }),
        ...(this.maxTokens && { [this.maxTokensParamName]: this.maxTokens }),
      }, {
        ...(this.llmTimeoutMs !== undefined && { timeout: this.llmTimeoutMs }),
      });
    } finally {
      if (ticker !== undefined) {
        clearInterval(ticker);
        // Erase the spinner line entirely — no trace left in the scrollback.
        const cols = process.stdout.columns ?? 80;
        process.stdout.write("\r" + " ".repeat(cols) + "\r");
      }
    }

    const choice = response.choices[0];
    if (!choice) {
      const finishReason = (response as { finish_reason?: string }).finish_reason;
      throw new Error(
        `LLM returned no choices (model: ${this.model}, finish_reason: ${finishReason ?? "none"}).` +
        ` This usually means the context window was exceeded or the request was filtered.`,
      );
    }

    const toolCalls = (choice.message.tool_calls ?? []).map((tc) => {
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
