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
  llmTimeoutSecs?: number,
  parallelToolCalls?: boolean,
  frequencyPenalty?: number,
): LLMProvider {
  switch (providerConfig.type) {
    case "copilot":
      return new CopilotProvider(model, reasoningEffort, maxTokens, llmTimeoutSecs, parallelToolCalls, frequencyPenalty);
    case "azure":
      return new AzureProvider(
        model,
        providerConfig.endpoint,
        providerConfig.apiVersion,
        reasoningEffort,
        maxTokens,
        llmTimeoutSecs,
        parallelToolCalls,
        frequencyPenalty,
      );
    case "ollama":
      return new OllamaProvider(model, providerConfig.baseUrl, maxTokens, llmTimeoutSecs, parallelToolCalls, frequencyPenalty);
    case "lm-studio":
      return new LmStudioProvider(model, providerConfig.baseUrl, maxTokens, llmTimeoutSecs, parallelToolCalls, frequencyPenalty);
    default:
      throw new Error(
        `Unknown LLM provider type: "${((providerConfig satisfies never) as { type: string }).type}". ` +
        `Valid types are: copilot, azure, ollama, lm-studio.`,
      );
  }
}
