import { z } from "zod";
import type { LLMMessage, LLMResponse, ToolDefinition } from "./types.ts";

export const ProviderConfigSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("copilot") }),
  z.object({
    type: z.literal("azure"),
    endpoint: z.string().min(1),
    apiVersion: z.string().min(1),
  }),
  z.object({
    type: z.literal("ollama"),
    baseUrl: z.string().optional(),
  }),
  z.object({
    type: z.literal("lm-studio"),
    baseUrl: z.string().optional(),
  }),
]);

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export interface LLMProvider {
  chat(messages: LLMMessage[], tools?: ToolDefinition[]): Promise<LLMResponse>;
}
