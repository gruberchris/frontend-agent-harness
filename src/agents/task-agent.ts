import { CopilotClient } from "../llm/copilot-client.ts";
import { emptyTokenUsage, type TokenUsage } from "../llm/types.ts";
import type { LLMMessage } from "../llm/types.ts";
import { buildMessageContent, type DesignContent } from "../design/design-loader.ts";

export interface TaskAgentResult {
  planContent: string;
  usage: TokenUsage;
}

export async function runTaskAgent(
  model: string,
  design: DesignContent,
  planFile: string,
  memoryFile: string,
  systemPrompt: string,
  reasoningEffort?: string,
  maxTokens?: number,
  existingFileTree?: string,
): Promise<TaskAgentResult> {
  const client = new CopilotClient(model, reasoningEffort, maxTokens);
  const usage = emptyTokenUsage();

  const existingPlan = (await Bun.file(planFile).exists()) ? await Bun.file(planFile).text() : "";
  const existingMemory = (await Bun.file(memoryFile).exists()) ? await Bun.file(memoryFile).text() : "";

  let feedbackSection = "";
  if (existingPlan || existingMemory) {
    feedbackSection = `\n\n### PREVIOUS ITERATION FEEDBACK & CONTEXT
The following information comes from a previous failed iteration. Use it to improve the plan and avoid repeating the same mistakes.

#### Previous Plan:
${existingPlan || "No previous plan found."}

#### Evaluator Memory (Lessons Learned):
${existingMemory || "No specific evaluator memory found yet."}
`;
  }

  let fileContextSection = "";
  if (existingFileTree) {
    fileContextSection = `\n\n### EXISTING OUTPUT FILES
The following files already exist from the previous iteration. Generate TARGETED correction tasks only — fix the reported issues without rebuilding things that are already working. Tasks should modify existing files rather than recreating them from scratch.

\`\`\`
${existingFileTree}
\`\`\`
`;
  }

  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: buildMessageContent(
        `Please create an implementation plan for the following design document:\n\n---\n${design.text}\n---${feedbackSection}${fileContextSection}\n\nGenerate the complete task list now. Ensure you address any issues mentioned in the feedback section above.`,
        design.images,
      ),
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
