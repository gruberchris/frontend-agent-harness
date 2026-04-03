import { createLLMClient } from "../llm/create-client.ts";
import type { ProviderConfig } from "../llm/provider.ts";
import { emptyTokenUsage, type TokenUsage } from "../llm/types.ts";
import type { LLMMessage } from "../llm/types.ts";
import { buildMessageContent, type DesignContent } from "../design/design-loader.ts";

export interface TaskAgentResult {
  planContent: string;
  usage: TokenUsage;
}

export async function runTaskAgent(
  model: string,
  providerConfig: ProviderConfig,
  design: DesignContent,
  planFile: string,
  memoryFile: string,
  systemPrompt: string,
  reasoningEffort?: string,
  maxTokens?: number,
  existingFileTree?: string,
  llmTimeoutSecs?: number,
): Promise<TaskAgentResult> {
  const client = createLLMClient(providerConfig, model, reasoningEffort, maxTokens, llmTimeoutSecs);
  const usage = emptyTokenUsage();

  const existingPlan = (await Bun.file(planFile).exists()) ? await Bun.file(planFile).text() : "";
  const existingMemory = (await Bun.file(memoryFile).exists()) ? await Bun.file(memoryFile).text() : "";

  let feedbackSection = "";
  if (existingPlan || existingMemory) {
    const correctionInstructions = existingMemory
      ? `IMPORTANT: You are in a correction iteration. The evaluator found problems that must be fixed.
The implementation agent executes tasks without access to the evaluator memory below — every detail needed to make each correction MUST be encoded in the task's Description and Acceptance Criteria.

For each distinct evaluator finding, create one dedicated correction task that:
- Names the specific problem (e.g. "Fix: submit button is red, should be blue")
- Specifies the exact file(s) to modify
- Describes precisely what change to make
- Includes testable acceptance criteria

Do NOT create a single vague "fix evaluator issues" task. Each finding → one task.`
      : `The following information comes from a previous iteration. Use it to improve the plan.`;

    feedbackSection = `\n\n### PREVIOUS ITERATION FEEDBACK & CONTEXT
${correctionInstructions}

#### Evaluator Memory (Lessons Learned):
${existingMemory || "No evaluator findings yet."}

#### Previous Plan:
${existingPlan || "No previous plan found."}
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
