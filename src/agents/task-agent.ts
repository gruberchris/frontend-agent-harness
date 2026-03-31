import { CopilotClient } from "../llm/copilot-client.ts";
import { emptyTokenUsage, type TokenUsage } from "../llm/types.ts";
import type { LLMMessage } from "../llm/types.ts";

export interface TaskAgentResult {
  planContent: string;
  usage: TokenUsage;
}

export async function runTaskAgent(
  model: string,
  designContent: string,
  planFile: string,
  systemPrompt: string,
  reasoningEffort?: string,
): Promise<TaskAgentResult> {
  const client = new CopilotClient(model, reasoningEffort);
  const usage = emptyTokenUsage();

  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `Please create an implementation plan for the following design document:\n\n---\n${designContent}\n---\n\nGenerate the complete task list now.`,
    },
  ];

  const response = await client.chat(messages);
  usage.promptTokens += response.usage.promptTokens;
  usage.completionTokens += response.usage.completionTokens;
  usage.totalTokens += response.usage.totalTokens;

  const planContent = response.content ?? "";
  await Bun.write(planFile, planContent + "\n");

  return { planContent, usage };
}
