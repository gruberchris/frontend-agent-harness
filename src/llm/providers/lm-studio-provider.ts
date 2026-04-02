import OpenAI from "openai";
import { OpenAICompatibleProvider } from "./base-provider.ts";

const DEFAULT_BASE_URL = "http://localhost:1234";

export class LmStudioProvider extends OpenAICompatibleProvider {
  protected override readonly supportsReasoningEffort = false;
  private baseUrl: string;

  constructor(model: string, baseUrl?: string, maxTokens?: number, llmTimeoutSecs?: number) {
    // reasoningEffort is not forwarded for LM Studio — pass undefined to super
    super(model, undefined, maxTokens, llmTimeoutSecs);
    this.baseUrl = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  protected async initClient(): Promise<void> {
    this.client = new OpenAI({
      baseURL: `${this.baseUrl}/v1`,
      apiKey: "lm-studio", // LM Studio does not require a real API key
    });
  }
}
