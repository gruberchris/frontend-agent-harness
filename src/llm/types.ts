export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type MessageContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | MessageContentPart[] | null;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface LLMResponse {
  content: string | null;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  finishReason: "stop" | "tool_calls" | "length" | "content_filter";
}

export function emptyTokenUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}
