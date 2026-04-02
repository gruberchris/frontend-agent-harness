import OpenAI from "openai";
import { OpenAICompatibleProvider } from "./base-provider.ts";

const DEFAULT_BASE_URL = "http://localhost:11434";

export class OllamaProvider extends OpenAICompatibleProvider {
  protected override readonly supportsReasoningEffort = false;
  private baseUrl: string;

  constructor(model: string, baseUrl?: string, maxTokens?: number) {
    // reasoningEffort is not forwarded for Ollama — pass undefined to super
    super(model, undefined, maxTokens);
    this.baseUrl = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  protected async initClient(): Promise<void> {
    this.client = new OpenAI({
      baseURL: `${this.baseUrl}/v1`,
      apiKey: "ollama", // Ollama does not require a real API key
    });
  }
}
