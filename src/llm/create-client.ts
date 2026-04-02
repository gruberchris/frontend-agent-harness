import type { ProviderConfig, LLMProvider } from "./provider.ts";
import { CopilotProvider } from "./providers/copilot-provider.ts";
import { AzureProvider } from "./providers/azure-provider.ts";
import { OllamaProvider } from "./providers/ollama-provider.ts";
import { LmStudioProvider } from "./providers/lm-studio-provider.ts";

export function createLLMClient(
  providerConfig: ProviderConfig,
  model: string,
  reasoningEffort?: string,
  maxTokens?: number,
): LLMProvider {
  switch (providerConfig.type) {
    case "copilot":
      return new CopilotProvider(model, reasoningEffort, maxTokens);
    case "azure":
      return new AzureProvider(
        model,
        providerConfig.endpoint,
        providerConfig.apiVersion,
        reasoningEffort,
        maxTokens,
      );
    case "ollama":
      return new OllamaProvider(model, providerConfig.baseUrl, maxTokens);
    case "lm-studio":
      return new LmStudioProvider(model, providerConfig.baseUrl, maxTokens);
    default:
      throw new Error(
        `Unknown LLM provider type: "${((providerConfig satisfies never) as { type: string }).type}". ` +
        `Valid types are: copilot, azure, ollama, lm-studio.`,
      );
  }
}
