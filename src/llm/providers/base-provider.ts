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
  protected llmStreamTimeoutMs?: number;
  protected readonly supportsReasoningEffort: boolean = true;
  /** Parameter name for the token limit. Subclasses may override to "max_completion_tokens". */
  protected readonly maxTokensParamName: string = "max_tokens";

  protected parallelToolCalls?: boolean;
  protected frequencyPenalty?: number;

  constructor(model: string, reasoningEffort?: string, maxTokens?: number, llmTimeoutSecs?: number, parallelToolCalls?: boolean, frequencyPenalty?: number, llmStreamTimeoutSecs?: number) {
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.maxTokens = maxTokens;
    this.llmTimeoutMs = llmTimeoutSecs !== undefined ? llmTimeoutSecs * 1000 : undefined;
    this.llmStreamTimeoutMs = llmStreamTimeoutSecs !== undefined ? llmStreamTimeoutSecs * 1000 : this.llmTimeoutMs;
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
    let spin = () => {};
    if (process.stdout.isTTY) {
      process.stdout.write("\x1B[?25l"); // hide cursor during spinner
      spin = () => {
        const elapsed = Math.round((Date.now() - tickerStart) / 1000);
        const frame = FRAMES[frameIdx++ % FRAMES.length];
        process.stdout.write(`\r    ${frame} 🤔 ${elapsed}s `);
      };
      spin();
      ticker = setInterval(spin, 100);
    }

    // Streaming chunk shape (subset we care about)
    type StreamChunk = {
      choices: Array<{
        index: number;
        delta: {
          content?: string | null;
          tool_calls?: Array<{
            index: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }> | null;
        };
        finish_reason: string | null;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
    };

    let content = "";
    let finishReason: LLMResponse["finishReason"] = "stop";
    const toolCallsAcc = new Map<number, { id: string; name: string; arguments: string }>();
    let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let hasChoices = false;

    try {
      // stream: true keeps the connection alive with a continuous flow of tokens,
      // preventing proxy/network idle-timeouts that would kill a long non-streaming request.
      const stream = await this.client.chat.completions.create(
        {
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
          stream: true,
          stream_options: { include_usage: true },
        } as Parameters<typeof this.client.chat.completions.create>[0],
        {
          // timeout: covers the initial response-headers phase (cleared by the SDK once headers arrive).
          // signal: AbortSignal.timeout covers the FULL streaming duration — the SDK wires it to
          //         the same abort controller, so it will abort mid-stream if the model is too slow.
          ...(this.llmTimeoutMs !== undefined && { timeout: this.llmTimeoutMs }),
          ...(this.llmStreamTimeoutMs !== undefined && { signal: AbortSignal.timeout(this.llmStreamTimeoutMs) }),
        },
      ) as unknown as AsyncIterable<StreamChunk>;

      for await (const chunk of stream) {
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens ?? 0,
            completionTokens: chunk.usage.completion_tokens ?? 0,
            totalTokens: chunk.usage.total_tokens ?? 0,
          };
          if (chunk.usage.completion_tokens) { /* usage captured above */ }
        }

        const choice = chunk.choices[0];
        if (!choice) continue;
        hasChoices = true;

        if (choice.delta.content) {
          content += choice.delta.content;
          spin();
        }
        if (choice.finish_reason) finishReason = choice.finish_reason as LLMResponse["finishReason"];

        for (const tc of choice.delta.tool_calls ?? []) {
          const acc = toolCallsAcc.get(tc.index) ?? { id: "", name: "", arguments: "" };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name += tc.function.name;
          if (tc.function?.arguments) {
            acc.arguments += tc.function.arguments;
            spin();
          }
          toolCallsAcc.set(tc.index, acc);
        }
      }
    } finally {
      if (ticker !== undefined) {
        clearInterval(ticker);
        // Erase the spinner line entirely — no trace left in the scrollback.
        const cols = process.stdout.columns ?? 80;
        process.stdout.write("\r" + " ".repeat(cols) + "\r");
        process.stdout.write("\x1B[?25h"); // restore cursor
      }
    }

    if (!hasChoices) {
      throw new Error(
        `LLM returned no choices (model: ${this.model}).` +
        ` This usually means the context window was exceeded or the request was filtered.`,
      );
    }

    const toolCalls = [...toolCallsAcc.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, tc]) => ({
        id: tc.id,
        name: tc.name,
        arguments: (() => {
          try {
            return JSON.parse(tc.arguments) as Record<string, unknown>;
          } catch {
            // JSON was truncated (model hit maxTokens mid-stream). Flag it so
            // callers can send an error back to the model rather than calling
            // the tool with missing arguments.
            return { __malformed: true } as Record<string, unknown>;
          }
        })(),
      }));

    return {
      content: content || null,
      toolCalls,
      usage,
      finishReason: finishReason ?? "stop",
    };
  }
}
