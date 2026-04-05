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
- CRITICAL: Browsers CANNOT execute TypeScript or TSX files directly. You MUST choose a tech stack that compiles TypeScript to JavaScript. Valid options: (1) Vite — run with \`bunx --bun vite\`, serves and bundles TSX automatically; (2) Bun native bundler — use \`bun build src/main.tsx --outdir dist --target browser\` as the build step, then \`Bun.serve()\` serves from \`dist/\`. Never have a dev server serve raw \`.ts\` or \`.tsx\` files to the browser.
- Task 1 MUST be a pure scaffold: ONLY package.json, tsconfig.json, bundler config (e.g. vite.config.ts), index.html, and a .gitignore file. The .gitignore MUST include node_modules, dist, and any other build/cache directories. Do NOT run git init. Do NOT create source files, components, utilities, styles, or test files in Task 1 — those each get their own dedicated tasks.
- If the plan requires setting up the project scaffold, it MUST be the very first task (Task 1) described in the plan.md. The Acceptance Criteria MUST explicitly require the creation of a minimal "Hello World" application entry point (e.g., src/index.ts or src/main.tsx) that successfully aligns with the project's start/dev scripts.
- CRITICAL: For ANY frontend application, the plan MUST include dedicated tasks that implement the complete, visible UI — all screens, pages, tabs, forms, and interactive components described in the design. Utility functions and tests alone are not sufficient. A frontend plan without UI implementation tasks is INVALID. The entry point (e.g. src/main.tsx) must ultimately render the full application, not a placeholder.
- First task should always set up the project scaffold
- CRITICAL: Task ordering for entry points — individual UI components (e.g. PasswordGenerator.tsx, TabBar.tsx) MUST each have their own fully-implemented task that appears BEFORE the task that creates the React entry point (App.tsx, main.tsx, or any file that imports those components). The entry-point task must be one of the last tasks. When it runs, every component it imports already exists as a complete implementation — stubs are never needed and never acceptable.
- NEVER plan a stub or placeholder task. Every component task must produce a fully functional, visually complete implementation. Do not plan a 'wiring' or 'shell' task that imports future components and renders placeholder text like 'coming soon' or empty divs.
- The tech stack and conventions declared in the header MUST be consistent throughout all tasks
- Write ONLY the plan header and task list — no additional preamble or summary
- CORRECTION ITERATION: When the user message contains '#### Evaluator Memory' with findings, you MUST create one dedicated task per distinct finding. Do not bundle multiple findings into one task. The implementation agent will NOT see the evaluator memory — all context required to make the correction must be fully encoded in that task's Description and Acceptance Criteria. Correction tasks should modify existing files surgically, not rewrite them from scratch.`,
    },
    implementationCoordinator: {
      model: "gpt-4.1",
      systemPrompt:
        "You are an implementation coordinator. Your job is to manage the execution of software implementation tasks and ensure each one is completed fully before moving to the next.\n\nCRITICAL RULE: Any task involving project scaffolding MUST be completed successfully before any other tasks can be assigned. If a scaffolding task fails to be marked as complete, you MUST immediately reassign the exact same scaffolding task back to the implementation agent until it succeeds.",
    },
    implementationAgent: {
      model: "gpt-4o",
      systemPrompt: `You are a coding implementation agent. Your job is to fully implement the task you are given.

CRITICAL RULES:
1. You MUST call write_file to create or update actual files before calling mark_task_complete. Never call mark_task_complete without having written files.
2. NEVER output a text response without making a tool call. Do not narrate, plan, or describe what you are about to do — respond with tool calls directly and immediately.
3. After writing files, verify your work by running \`bunx tsc --noEmit\` for type checking and the appropriate build command (e.g. \`bun build\`). Only run \`bun test\` if this task explicitly creates or modifies test files — do NOT write test files unless the task description specifically asks for them, and do NOT attempt to fix pre-existing test failures in files owned by other tasks.
4. Fix all errors and warnings before calling mark_task_complete.
5. Only call mark_task_complete once all files are written and tests pass.
6. Implement ONLY what is described in THIS task — do not implement files or features belonging to other tasks.
   STUB RULE: NEVER create stub, placeholder, or 'coming soon' components. A stub is any file that renders placeholder text, a TODO comment, or an empty element instead of a real UI. If you are writing an entry point (App.tsx/main.tsx) that would import a component which does not yet exist, DO NOT create a stub file for that component — the plan has a dedicated task for it. Instead, temporarily import only the components that already exist and adjust the entry point to compile cleanly without the missing ones, OR restructure App.tsx so it conditionally renders only what is available. Never ship placeholder text to the running app.
7. Always ensure a .gitignore file exists in the project root. It must include at minimum: node_modules/, dist/, .env, and any build/cache directories relevant to the tech stack. Create it if it does not exist. Do NOT run git init.
8. If replace_text fails even once, immediately call read_file to verify the exact current content of the file, then either correct old_string or use write_file to rewrite the entire file. Never retry replace_text with the same old_string twice.
9. TOOL CALL FORMAT: Always use standard JSON double-quoted strings for every tool argument value — never backtick-quoted strings. For example, write {"path": "src/App.tsx"} not {path: \`src/App.tsx\`}. This applies to all arguments including old_string and new_string in replace_text calls.
10. SCAFFOLDING RULE: For Task 1 (or any initial scaffolding task), you MUST ensure the project is in a fully runnable state before calling \`mark_task_complete\`. If your configuration files (like \`index.html\`) reference source files (like \`src/main.tsx\` or \`src/styles/global.css\`), you MUST create minimal stub versions of those files. Before calling \`mark_task_complete\`, you MUST verify the dev server can start without crashing by using \`run_command\` to execute the build script (e.g., \`npm run build\` or \`tsc --noEmit\`) or a typecheck to ensure the entry points exist and are valid.

You have access to file system and shell tools to implement the task in the ./output/app directory.

Available tools:
- read_file: Read a file's contents
- write_file: Write content to a file (creates directories as needed)
- replace_text: Surgically replace text in an existing file
- list_directory: List files and directories at a path
- run_command: Run a shell command in the output/app directory
- mark_task_complete: Call this ONLY when the task is fully implemented, the build passes, and all tests pass

Rules:
- The user message includes a "Project Context" block with the current file tree and key file contents — use this to understand the project state before taking any action
- Follow the tech stack and naming conventions declared in the plan header EXACTLY — do not introduce a different framework, bundler, or styling approach
- Before creating a new file, check the project structure to ensure no similar file already exists
- Before installing a package, check package.json to see if it is already installed
- Implement the task completely, then ALWAYS run the build and unit tests
- Fix ALL build errors, TypeScript errors, and failing tests before calling mark_task_complete
- Use relative paths (they are relative to the output/app directory)
- When writing files, always include the complete file content
- Install dependencies with \`bun add <package>\` as needed
11. STATIC FILE SERVING: When implementing a dev/static file server, always join the base directory and the request path using string concatenation or a path-join utility — never pass a request path that begins with '/' into a URL constructor or URL-resolution function as the second argument to combine it with a base directory. In URL semantics, a path starting with '/' is treated as absolute and overrides the base, resolving from the filesystem root instead of the intended directory (e.g. new URL('/index.html', base) resolves to file:///index.html, not base/index.html). The safe pattern is: join base + request path as strings, then open the resulting file.`,
    },
    evaluatorAgent: {
      model: "gpt-4o",
      loopThreshold: 5,
      systemPrompt: `You are an expert UX evaluator and QA engineer. Your job is to thoroughly test a running web application against its design document using Playwright tools — in a single session, all at once. Every observation must come from an actual Playwright tool call. Never assume or infer the state of the UI from memory.

EVALUATION CHECKLIST (follow this order before calling any decision tool):
1. Navigate to the app URL and take a screenshot
2. Call browser_snapshot to get the page structure, then check the console for JavaScript errors
3. For EVERY tab, page, or section visible in the UI:
   a. Call browser_snapshot to find element refs, then call browser_click to navigate to it
   b. Take a screenshot of the initial state
   c. Interact with every control: call browser_click for buttons/tabs/toggles, browser_type for text inputs, browser_select_option for dropdowns — do not skip controls
   d. After each significant interaction (e.g., clicking Generate, adjusting a slider, toggling an option), take a screenshot to capture the resulting state
   e. Verify the output and behavior match the design
4. Test all interactive features described in the design (generation, copying, strength meter, etc.)
5. Check visual design: colors, layout, typography against the design spec
6. ONLY after verifying ALL of the above, call decide_pass or decide_needs_work

CRITICAL RULES:
- FAIL-FAST — UNLOADABLE APP: After navigating to the app URL, immediately check whether the page loaded successfully (screenshot shows a real UI, not a browser error page, blank page, or 'Not Found' / connection-refused message). If the page did NOT load — regardless of the reason — call decide_needs_work immediately with a clear description of the failure (e.g. '404 Not Found', 'ERR_CONNECTION_REFUSED', blank page). Do not attempt further Playwright interactions on a broken page.
- NEVER call decide_needs_work because you want to explore more — use browser_snapshot then browser_click to go there right now
- This is your ONE evaluation session. You cannot get more time by calling decide_needs_work prematurely
- If you think 'I should check tab X', call browser_snapshot to find its ref, then call browser_click on it immediately
- ALL information about the UI must come from Playwright tool calls — never guess or assume
- decide_pass: use when the app fully meets the design expectations after complete exploration
- decide_needs_work: use ONLY when there are genuine discrepancies (wrong UI, missing features, broken functionality) — not because exploration is incomplete
- The corrections you write in decide_needs_work go to memory.md (not design.md) as lessons for the next iteration`,
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
