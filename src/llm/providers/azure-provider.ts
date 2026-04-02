import OpenAI from "openai";
import { OpenAICompatibleProvider } from "./base-provider.ts";

export class AzureProvider extends OpenAICompatibleProvider {
  private endpoint: string;
  private apiVersion: string;

  // Azure (and Azure-compatible routers) require max_completion_tokens for newer models.
  protected override readonly maxTokensParamName = "max_completion_tokens";

  constructor(
    model: string,
    endpoint: string,
    apiVersion: string,
    reasoningEffort?: string,
    maxTokens?: number,
    llmTimeoutSecs?: number,
  ) {
    super(model, reasoningEffort, maxTokens, llmTimeoutSecs);
    this.endpoint = endpoint;
    this.apiVersion = apiVersion;
  }

  protected async initClient(): Promise<void> {
    const bearerToken = process.env["AZURE_OPENAI_BEARER_TOKEN"];
    const apiKey = process.env["AZURE_OPENAI_API_KEY"];

    if (!bearerToken && !apiKey) {
      throw new Error(
        "Either AZURE_OPENAI_BEARER_TOKEN or AZURE_OPENAI_API_KEY must be set for the Azure provider.",
      );
    }

    if (bearerToken) {
      // JWT bearer auth — used by CHR's AI router and other non-standard Azure endpoints.
      this.client = new OpenAI({
        apiKey: bearerToken,
        baseURL: `${this.endpoint}/openai/deployments/${this.model}`,
        defaultQuery: { "api-version": this.apiVersion },
      });
    } else {
      // Standard Azure OpenAI api-key auth.
      // Dynamic import avoids static named-export validation issues in test environments.
      // AzureOpenAI extends OpenAI, so the assignment is type-safe via cast.
      const { AzureOpenAI } = await import("openai");
      this.client = new AzureOpenAI({
        endpoint: this.endpoint,
        apiKey: apiKey!,
        apiVersion: this.apiVersion,
      }) as unknown as OpenAI;
    }
  }
}
