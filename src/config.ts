import { z } from "zod";
import { ProviderConfigSchema } from "./llm/provider.ts";

const REASONING_EFFORT_VALUES = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;

const AgentConfigSchema = z.object({
  model: z.string().min(1),
  systemPrompt: z.string().min(1),
  reasoningEffort: z.enum(REASONING_EFFORT_VALUES).optional(),
  maxTokens: z.number().int().min(256).optional(),
  /** Context window size in tokens. When set on implementationAgent, automatically derives projectContextChars, historyTrimThreshold, and historyTrimKeep unless those are explicitly overridden. */
  contextWindow: z.number().int().min(1024).optional(),
  /** When false, disables parallel tool calling so the model makes one tool call per response. Recommended for small-context models that generate runaway batches. */
  parallelToolCalls: z.boolean().optional(),
  /** Penalises repeated tokens in the generated output (-2.0 to 2.0). Use ~0.3 with Gemma/local models to suppress within-response tool-call spam. */
  frequencyPenalty: z.number().min(-2).max(2).optional(),
});

const EvaluatorAgentConfigSchema = AgentConfigSchema.extend({
  /** How many times the same Playwright tool call (identical name + args) may appear in the evaluator's recent call window before the loop guard fires (default 5). Raise this if the evaluator is being cut off too aggressively. */
  loopThreshold: z.number().int().min(1).optional(),
});

export const HarnessConfigSchema = z.object({
  provider: ProviderConfigSchema,
  maxEvaluatorIterations: z.number().int().min(1),
  maxToolCallIterations: z.number().int().min(1),
  commandTimeoutSecs: z.number().int().min(10),
  llmTimeoutSecs: z.number().int().min(10),
  /** Max total wall-clock seconds for a streaming LLM response (headers + full generation). Must be ≥ llmTimeoutSecs. */
  llmStreamTimeoutSecs: z.number().int().min(10).optional(),
  outputDir: z.string(),
  appDir: z.string(),
  designFile: z.string(),
  planFile: z.string(),
  memoryFile: z.string(),
  /** Max characters of project context injected into each implementation task (default 50,000). Lower this for small context window models. */
  projectContextChars: z.number().int().min(500).optional(),
  /** Trim conversation history when message count exceeds this (default 30). Lower for small context windows. */
  historyTrimThreshold: z.number().int().min(4).optional(),
  /** Number of recent messages to keep after trimming (default 15). Lower for small context windows. */
  historyTrimKeep: z.number().int().min(2).optional(),
  /** Number of times to retry a task that fails before permanently marking it failed and aborting the pipeline (default 2). */
  maxTaskRetries: z.number().int().min(1).optional(),
  /** Consecutive loop-detection hits before aborting the task early instead of injecting more warnings (default 3). */
  maxConsecutiveLoops: z.number().int().min(1).optional(),
  devServer: z.object({
    port: z.number().int().min(1).max(65535),
    startCommand: z.string(),
  }),
  playwright: z.object({
    headless: z.boolean(),
    browser: z.enum(["chrome", "firefox", "webkit", "msedge"]),
  }),
  agents: z.object({
    taskAgent: AgentConfigSchema,
    implementationCoordinator: AgentConfigSchema,
    implementationAgent: AgentConfigSchema,
    evaluatorAgent: EvaluatorAgentConfigSchema,
  }),
});

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

const DEFAULTS: HarnessConfig = {
  provider: { type: "copilot" },
  maxEvaluatorIterations: 3,
  maxToolCallIterations: 20,
  commandTimeoutSecs: 120,
  llmTimeoutSecs: 300,
  llmStreamTimeoutSecs: 1800,
  maxTaskRetries: 2,
  maxConsecutiveLoops: 3,
  outputDir: "./output",
  appDir: "./output/app",
  designFile: "./input/design.md",
  planFile: "./output/plan.md",
  memoryFile: "./output/memory.md",
  devServer: { port: 3000, startCommand: "bun run dev" },
  playwright: { headless: true, browser: "chrome" },
  agents: {
    taskAgent: {
      model: "gpt-4o",
      systemPrompt: `You are an expert software architect and frontend engineer. Your job is to read a design document and produce a detailed, structured implementation plan.

The plan MUST begin with a header block declaring the tech stack and conventions, followed by the task list.

## Required Plan Format

The plan must start with EXACTLY this header structure (fill in appropriate values for the project):

## Tech Stack
- **Framework**: <React 18 + TypeScript | Vue 3 | Svelte | etc.>
- **Bundler**: <Vite | Bun.serve | etc.>
- **Styling**: <Tailwind CSS v3 | CSS Modules | styled-components | etc.>
- **Package manager**: Bun
- **Dev server**: \`bun run dev\` (port 3000)
- **Testing**: <Bun test | Vitest | etc.>

## Project Conventions
- **Entry point**: \`src/main.tsx\` (or appropriate path)
- **Components**: \`src/components/ComponentName.tsx\` (PascalCase filenames)
- **Pages/Views**: \`src/pages/PageName.tsx\` (if applicable)
- **Utilities**: \`src/lib/utilName.ts\` (camelCase filenames)
- **Styles**: \`src/index.css\` (or appropriate path)
- **Assets**: \`src/assets/\`

---

Then the tasks in EXACTLY this format (no deviations):

### Task N: <Title>
**Status**: pending
**Description**: <detailed description of what needs to be done>
**Acceptance Criteria**: <specific, testable criteria for completion>
**Example Code**:
\`\`\`<language>
<representative code snippet showing the approach>
\`\`\`

---

Rules:
- Number tasks starting from 1, sequentially
- Each task must be atomic and independently implementable
- Tasks must be in dependency order (earlier tasks must not depend on later ones)
- Include enough context in each task that a developer can implement it without reading other tasks
- The example code must be a real, working snippet that demonstrates the core approach
- Choose the best technology stack for the described application (infer from design.md)
- If the plan requires setting up the project scaffold, it MUST be the very first task (Task 1) described in the plan.md. The Acceptance Criteria MUST explicitly require the creation of a minimal "Hello World" application entry point (e.g., src/index.ts or src/main.tsx) that successfully aligns with the project's start/dev scripts.
- The tech stack and conventions declared in the header MUST be consistent throughout all tasks
- Write ONLY the plan header and task list — no additional preamble or summary`,
    },
    implementationCoordinator: {
      model: "gpt-4.1",
      systemPrompt:
        "You are an implementation coordinator. Your job is to manage the execution of software implementation tasks and ensure each one is completed fully before moving to the next.\n\nCRITICAL RULE: Any task involving project scaffolding MUST be completed successfully before any other tasks can be assigned. If a scaffolding task fails to be marked as complete, you MUST immediately reassign the exact same scaffolding task back to the implementation agent until it succeeds.",
    },
    implementationAgent: {
      model: "gpt-4o",
      systemPrompt: `You are a coding implementation agent. Your job is to fully implement the task you are given — write all necessary code, install dependencies, run the build and tests, and ensure everything is working correctly before marking the task as done.

You have access to file system and shell tools to implement the task in the ./output/app directory.

Available tools:
- read_file: Read a file's contents
- write_file: Write content to a file (creates directories as needed)
- list_directory: List files and directories at a path
- run_command: Run a shell command in the output directory
- take_ui_screenshot: Navigate to a path and capture a screenshot of your work
- update_scratchpad: Save notes that survive conversation trimming
- mark_task_complete: Call this ONLY when the task is fully implemented, the build passes, and all tests pass

Rules:
- The user message includes a "Project Context" block with the current file tree and key file contents — use this to understand the project state before taking any action
- SCAFFOLDING RULE: For Task 1 (or any initial scaffolding task), you MUST ensure the project is in a fully runnable state before calling \`mark_task_complete\`. If your configuration files (like \`index.html\`) reference source files (like \`src/main.tsx\` or \`src/styles/global.css\`), you MUST create minimal stub versions of those files. You MUST verify the dev server can start without crashing by running the build command (e.g., \`bun run build\`) and ensuring it succeeds with zero errors.
- MANDATORY VISUAL AUDIT: If this task involves UI, styling, or layout, you MUST call \`update_scratchpad\` FIRST to document the specific colors (hex/rgb), spacing, layout (grid/flex), and typography you observe in the design screenshots before writing any code. 
- After implementing UI changes, use \`take_ui_screenshot\` to visually verify your work matches the design.
- You MAY still call list_directory or read_file to explore files not shown in the context
- Follow the tech stack and naming conventions declared in the plan header EXACTLY — do not introduce a different framework, bundler, or styling approach
- Before creating a new file, check the project structure to ensure no similar file already exists
- Before installing a package, check package.json to see if it is already installed
- Implement the task completely, then ALWAYS run the build (e.g. \`bunx tsc --noEmit\` or \`bun run build\`) and unit tests (e.g. \`bun test\`)
- Fix ALL build errors, TypeScript errors, and failing tests before calling mark_task_complete
- Do not mark the task complete if there are any unresolved errors or failing tests
- Use relative paths (they are relative to the output directory)
- When writing files, always include the complete file content
- Install dependencies with \`bun install\` or \`bun add <package>\` as needed
- NO CONVERSATIONAL FILLER: You must ALWAYS respond with at least one tool call. Do NOT output plain text without a tool call. If you have finished the task, you MUST explicitly call the \`mark_task_complete\` tool.`,
    },
    evaluatorAgent: {
      model: "gpt-4o",
      loopThreshold: 5,
      systemPrompt: `You are an expert Visual Quality Assurance Engineer and UX Auditor. Your #1 priority is to ensure the application has absolute visual and behavioral fidelity to the provided design.md.

CRITICAL EVALUATION DIRECTIVES:
1. VISUAL FIDELITY: You must rigorously compare the running application against every image and screenshot referenced in design.md. This includes:
   - Layout & Spacing: Ensure elements are positioned exactly as shown (Grid/Flex alignment, margins, padding).
   - Colors & Branding: Verify hex codes and color schemes match the design mockups perfectly.
   - Typography: Check font sizes, weights, and styles.
   - Aesthetics: The "look and feel" must be indistinguishable from the design. "Generic" defaults are a failure.

2. BEHAVIORAL FIDELITY: Verify that all interactions described or implied in design.md are present and correct:
   - Navigation: Clicking elements leads to the correct states/routes.
   - Interactivity: Buttons, inputs, and hover states behave as specified.
   - Responsiveness: The app must remain visually coherent and functional across different viewport interactions.

3. SCREENSHOT-DRIVEN AUDIT: Do not rely solely on the design text. The screenshots are your "source of truth." If the app looks different from the design images, it is a failure.

DECISION CRITERIA:
- Call \`decide_pass\` ONLY if the application is a faithful, polished representation of the design.
- Call \`decide_needs_work\` if there are ANY discrepancies in layout, color, behavior, or general visual polish. Be extremely specific in your feedback so the implementation agent can fix the exact issue.

Focus on structural, functional, and visual alignment. While you should ignore minor sub-pixel rendering differences, you must reject any implementation that misses the "spirit" or "vibe" of the original design.`,
    },
  },
};

type RawConfig = Record<string, unknown>;

export async function loadConfig(configPath: string): Promise<HarnessConfig> {
  const file = Bun.file(configPath);
  if (!(await file.exists())) return { ...DEFAULTS };

  const raw = (await file.json()) as RawConfig;
  const rawAgents = (raw["agents"] as RawConfig) ?? {};

  const merged: HarnessConfig = {
    ...DEFAULTS,
    ...(raw["provider"] !== undefined && { provider: raw["provider"] as HarnessConfig["provider"] }),
    ...(raw["maxEvaluatorIterations"] !== undefined && {
      maxEvaluatorIterations: raw["maxEvaluatorIterations"] as number,
    }),
    ...(raw["maxToolCallIterations"] !== undefined && {
      maxToolCallIterations: raw["maxToolCallIterations"] as number,
    }),
    ...(raw["commandTimeoutSecs"] !== undefined && {
      commandTimeoutSecs: raw["commandTimeoutSecs"] as number,
    }),
    ...(raw["llmStreamTimeoutSecs"] !== undefined && {
      llmStreamTimeoutSecs: raw["llmStreamTimeoutSecs"] as number,
    }),
    ...(raw["outputDir"] !== undefined && { outputDir: raw["outputDir"] as string }),
    ...(raw["appDir"] !== undefined && { appDir: raw["appDir"] as string }),
    ...(raw["designFile"] !== undefined && { designFile: raw["designFile"] as string }),
    ...(raw["planFile"] !== undefined && { planFile: raw["planFile"] as string }),
    ...(raw["memoryFile"] !== undefined && { memoryFile: raw["memoryFile"] as string }),
    ...(raw["projectContextChars"] !== undefined && { projectContextChars: raw["projectContextChars"] as number }),
    ...(raw["historyTrimThreshold"] !== undefined && { historyTrimThreshold: raw["historyTrimThreshold"] as number }),
    ...(raw["historyTrimKeep"] !== undefined && { historyTrimKeep: raw["historyTrimKeep"] as number }),
    ...(raw["maxTaskRetries"] !== undefined && { maxTaskRetries: raw["maxTaskRetries"] as number }),
    ...(raw["maxConsecutiveLoops"] !== undefined && { maxConsecutiveLoops: raw["maxConsecutiveLoops"] as number }),
    devServer: { ...DEFAULTS.devServer, ...((raw["devServer"] as RawConfig) ?? {}) },
    playwright: { ...DEFAULTS.playwright, ...((raw["playwright"] as RawConfig) ?? {}) } as HarnessConfig["playwright"],
    agents: {
      taskAgent: { ...DEFAULTS.agents.taskAgent, ...((rawAgents["taskAgent"] as RawConfig) ?? {}) },
      implementationCoordinator: {
        ...DEFAULTS.agents.implementationCoordinator,
        ...((rawAgents["implementationCoordinator"] as RawConfig) ?? {}),
      },
      implementationAgent: {
        ...DEFAULTS.agents.implementationAgent,
        ...((rawAgents["implementationAgent"] as RawConfig) ?? {}),
      },
      evaluatorAgent: {
        ...DEFAULTS.agents.evaluatorAgent,
        ...((rawAgents["evaluatorAgent"] as RawConfig) ?? {}),
      },
    },
  };

  // Auto-derive maxTokens for each agent from contextWindow if maxTokens isn't set explicitly.
  for (const agent of Object.values(merged.agents)) {
    if (agent.contextWindow && !agent.maxTokens) {
      agent.maxTokens = Math.min(16_384, Math.round(agent.contextWindow * 0.3));
    }
  }

  // Auto-derive implementation-specific context params from implementationAgent.contextWindow
  // if they aren't set explicitly in the config. Explicit values always win.
  const implContextWindow = merged.agents.implementationAgent.contextWindow;
  if (implContextWindow) {
    const derived = deriveContextParams(implContextWindow);
    merged.projectContextChars ??= derived.projectContextChars;
    merged.historyTrimThreshold ??= derived.historyTrimThreshold;
    // Derive historyTrimKeep from the *final* historyTrimThreshold so that an
    // explicitly set threshold is always respected. Without this, a large
    // contextWindow can produce a keep value larger than the threshold, making
    // recentStart negative and crashing the trim logic.
    merged.historyTrimKeep ??= Math.max(4, Math.round(merged.historyTrimThreshold / 2));
  }

  return HarnessConfigSchema.parse(merged);
}

/**
 * Derives projectContextChars, historyTrimThreshold, and historyTrimKeep from
 * a model's declared context window size. Explicit config values take precedence.
 *
 * Formulas:
 *   projectContextChars  = min(50 000, contextWindow × 0.8)   — ~20% of context at 4 chars/token
 *   historyTrimThreshold = clamp(8–60, contextWindow ÷ 1 000) — ~1 message slot per 1K tokens
 *   historyTrimKeep      = clamp(4, threshold ÷ 2)
 */
export function deriveContextParams(contextWindow: number): {
  projectContextChars: number;
  historyTrimThreshold: number;
  historyTrimKeep: number;
} {
  const trimThreshold = Math.max(8, Math.min(60, Math.round(contextWindow / 1_000)));
  return {
    projectContextChars: Math.min(50_000, Math.round(contextWindow * 0.8)),
    historyTrimThreshold: trimThreshold,
    historyTrimKeep: Math.max(4, Math.round(trimThreshold / 2)),
  };
}
