import OpenAI from "openai";
import { OpenAICompatibleProvider } from "./base-provider.ts";

export class AzureProvider extends OpenAICompatibleProvider {
  private endpoint: string;
  private apiVersion: string;

  constructor(
    model: string,
    endpoint: string,
    apiVersion: string,
    reasoningEffort?: string,
    maxTokens?: number,
  ) {
    super(model, reasoningEffort, maxTokens);
    this.endpoint = endpoint;
    this.apiVersion = apiVersion;
  }

  protected async initClient(): Promise<void> {
    const apiKey = process.env["AZURE_OPENAI_API_KEY"];
    if (!apiKey) {
      throw new Error(
        "AZURE_OPENAI_API_KEY environment variable is required for the Azure provider.",
      );
    }
    // Dynamic import avoids static named-export validation issues in test environments.
    // AzureOpenAI extends OpenAI, so the assignment is type-safe via cast.
    const { AzureOpenAI } = await import("openai");
    this.client = new AzureOpenAI({
      endpoint: this.endpoint,
      apiKey,
      apiVersion: this.apiVersion,
    }) as unknown as OpenAI;
  }
}
