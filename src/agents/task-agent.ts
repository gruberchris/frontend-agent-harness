import { createLLMClient } from "../llm/create-client.ts";
import type { ProviderConfig } from "../llm/provider.ts";
import { emptyTokenUsage, type TokenUsage } from "../llm/types.ts";
import type { LLMMessage } from "../llm/types.ts";
import { buildMessageContent, type DesignContent } from "../design/design-loader.ts";
import { appendTasks } from "../plan/plan-parser.ts";

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
  correctionMode?: boolean,
  nextTaskNumber?: number,
  llmStreamTimeoutSecs?: number,
): Promise<TaskAgentResult> {
  const client = createLLMClient(providerConfig, model, reasoningEffort, maxTokens, llmTimeoutSecs, undefined, undefined, llmStreamTimeoutSecs);
  const usage = emptyTokenUsage();

  const existingMemory = (await Bun.file(memoryFile).exists()) ? await Bun.file(memoryFile).text() : "";

  // ── Correction mode: append targeted fix tasks to the existing plan ──────────
  // Instead of regenerating the full plan (which causes the task agent to produce
  // a fresh scaffold), we ask only for new correction tasks starting from the next
  // available task number and APPEND them to the existing plan.md.
  if (correctionMode) {
    const startN = nextTaskNumber ?? 1;
    const fileTreeSection = existingFileTree
      ? `\n\nExisting files in the project (already built — do NOT recreate, only modify):\n\`\`\`\n${existingFileTree}\n\`\`\``
      : "";

    const correctionPrompt =
      `CORRECTION MODE — output ONLY new correction task sections, nothing else.\n\n` +
      `DO NOT output: a plan header (## Tech Stack / ## Project Conventions), ` +
      `previously completed tasks, or a scaffold / project-setup task.\n\n` +
      `DO output: one ### Task N: section per evaluator finding below, ` +
      `numbered starting from Task ${startN}. ` +
      `Each task must surgically modify specific existing files to fix the reported issue.\n\n` +
      `Evaluator findings to fix:\n---\n${existingMemory}\n---` +
      fileTreeSection;

    const messages: LLMMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: buildMessageContent(correctionPrompt, design.images) },
    ];

    const response = await client.chat(messages);
    usage.promptTokens += response.usage.promptTokens;
    usage.completionTokens += response.usage.completionTokens;
    usage.totalTokens += response.usage.totalTokens;

    const planContent = response.content ?? "";
    await appendTasks(planFile, planContent);
    return { planContent, usage };
  }

  // ── Normal mode: generate (or regenerate) the full plan ──────────────────────
  const existingPlan = (await Bun.file(planFile).exists()) ? await Bun.file(planFile).text() : "";

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
