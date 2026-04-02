import { z } from "zod";
import { ProviderConfigSchema } from "./llm/provider.ts";

const REASONING_EFFORT_VALUES = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;

const AgentConfigSchema = z.object({
  model: z.string().min(1),
  systemPrompt: z.string().min(1),
  reasoningEffort: z.enum(REASONING_EFFORT_VALUES).optional(),
  maxTokens: z.number().int().min(256).optional(),
});

export const HarnessConfigSchema = z.object({
  provider: ProviderConfigSchema,
  maxEvaluatorIterations: z.number().int().min(1),
  maxToolCallIterations: z.number().int().min(1),
  resetAppOnRetry: z.boolean(),
  outputDir: z.string(),
  appDir: z.string(),
  designFile: z.string(),
  planFile: z.string(),
  memoryFile: z.string(),
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
    evaluatorAgent: AgentConfigSchema,
  }),
});

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

const DEFAULTS: HarnessConfig = {
  provider: { type: "copilot" },
  maxEvaluatorIterations: 3,
  maxToolCallIterations: 20,
  resetAppOnRetry: false,
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
- First task should always set up the project scaffold
- The tech stack and conventions declared in the header MUST be consistent throughout all tasks
- Write ONLY the plan header and task list — no additional preamble or summary`,
    },
    implementationCoordinator: {
      model: "gpt-4.1",
      systemPrompt:
        "You are an implementation coordinator. Your job is to manage the execution of software implementation tasks and ensure each one is completed fully before moving to the next.",
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
- mark_task_complete: Call this ONLY when the task is fully implemented, the build passes, and all tests pass

Rules:
- The user message includes a "Project Context" block with the current file tree and key file contents — use this to understand the project state before taking any action
- You MAY still call list_directory or read_file to explore files not shown in the context
- Follow the tech stack and naming conventions declared in the plan header EXACTLY — do not introduce a different framework, bundler, or styling approach
- Before creating a new file, check the project structure to ensure no similar file already exists
- Before installing a package, check package.json to see if it is already installed
- Implement the task completely, then ALWAYS run the build (e.g. \`bunx tsc --noEmit\` or \`bun run build\`) and unit tests (e.g. \`bun test\`)
- Fix ALL build errors, TypeScript errors, and failing tests before calling mark_task_complete
- Do not mark the task complete if there are any unresolved errors or failing tests
- Use relative paths (they are relative to the output directory)
- When writing files, always include the complete file content
- Install dependencies with \`bun install\` or \`bun add <package>\` as needed`,
    },
    evaluatorAgent: {
      model: "gpt-4o",
      systemPrompt: `You are an expert UX evaluator and QA engineer. Your job is to:
1. Navigate to the running web application using Playwright tools
2. Take screenshots and interact with the UI
3. Compare what you see against the original design document
4. Decide if the application meets the design expectations

At the end of your evaluation, you MUST call either:
- decide_pass: if the application fully meets the design expectations
- decide_needs_work: if there are significant discrepancies that need to be fixed

When deciding NEEDS_WORK, be specific about what is missing or wrong.
Focus on functional and visual alignment with the design — ignore minor pixel-perfect differences.`,
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
    ...(raw["resetAppOnRetry"] !== undefined && {
      resetAppOnRetry: raw["resetAppOnRetry"] as boolean,
    }),
    ...(raw["outputDir"] !== undefined && { outputDir: raw["outputDir"] as string }),
    ...(raw["appDir"] !== undefined && { appDir: raw["appDir"] as string }),
    ...(raw["designFile"] !== undefined && { designFile: raw["designFile"] as string }),
    ...(raw["planFile"] !== undefined && { planFile: raw["planFile"] as string }),
    ...(raw["memoryFile"] !== undefined && { memoryFile: raw["memoryFile"] as string }),
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

  return HarnessConfigSchema.parse(merged);
}
