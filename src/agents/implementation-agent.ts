import { createLLMClient } from "../llm/create-client.ts";
import type { ProviderConfig } from "../llm/provider.ts";
import { addTokenUsage, emptyTokenUsage, type TokenUsage } from "../llm/types.ts";
import type { LLMMessage, ToolDefinition } from "../llm/types.ts";
import { updateTaskStatus } from "../plan/plan-parser.ts";
import type { PlanTask } from "../plan/types.ts";
import { buildMessageContent, type DesignContent } from "../design/design-loader.ts";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";

const IMPL_TOOLS: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read the contents of a file in the output directory",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a new file in the output directory (creates parent directories)",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file" },
        content: { type: "string", description: "Complete file content" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "replace_text",
    description: "Surgically replace exact text in a file. Use this instead of write_file for modifying existing files to save tokens.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file" },
        old_string: { type: "string", description: "The exact literal text to replace. Must match exactly." },
        new_string: { type: "string", description: "The new text to insert." },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "undo_edit",
    description: "Reverts a file to its state before the last write_file or replace_text operation.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file" },
      },
      required: ["path"],
    },
  },
  {
    name: "glob",
    description: "Find files matching a glob pattern (e.g., src/**/*.ts).",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern to match" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "grep_search",
    description: "Search for a regex pattern in files.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        dir: { type: "string", description: "Optional directory to search in, defaults to '.'" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "view_code_symbols",
    description: "Returns an outline of a file (classes, functions) without full implementation.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file" },
      },
      required: ["path"],
    },
  },
  {
    name: "read_url",
    description: "Fetch text content from a URL (useful for reading docs).",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
      },
      required: ["url"],
    },
  },
  {
    name: "list_directory",
    description: "List files and directories at a path in the output directory",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to list (use '.' for root)",
          default: ".",
        },
      },
      required: [],
    },
  },
  {
    name: "run_command",
    description: "Run a shell command in the output directory",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run" },
      },
      required: ["command"],
    },
  },
  {
    name: "mark_task_complete",
    description: "Mark the current task as completed. Call this when implementation is done.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "Brief summary of what was implemented",
        },
      },
      required: ["summary"],
    },
  },
];

export interface ImplementationAgentResult {
  summary: string;
  usage: TokenUsage;
}

export async function runImplementationAgent(
  model: string,
  providerConfig: ProviderConfig,
  task: PlanTask,
  design: DesignContent,
  planFile: string,
  outputDir: string,
  projectContext: string | undefined,
  systemPrompt: string,
  reasoningEffort?: string,
  maxTokens?: number,
  maxToolCallIterations = 50,
  commandTimeoutSecs = 120,
  llmTimeoutSecs?: number,
): Promise<ImplementationAgentResult> {
  const client = createLLMClient(providerConfig, model, reasoningEffort, maxTokens, llmTimeoutSecs);
  let usage = emptyTokenUsage();

  const absOutputDir = path.resolve(outputDir);
  await fs.mkdir(absOutputDir, { recursive: true });

  const contextSection = projectContext
    ? `## Project Context (pre-injected — use this to understand the current state)\n\n${projectContext}\n\n---\n\n`
    : "";

  // Cap design text per task — the plan header already captures tech stack/conventions,
  // so repeating the full design doc on every task wastes tokens.
  const DESIGN_TEXT_CAP = 2_000;
  const designContext = design.text.length > DESIGN_TEXT_CAP
    ? design.text.slice(0, DESIGN_TEXT_CAP) + `\n\n...(design text truncated at ${DESIGN_TEXT_CAP} chars — full spec captured in plan header above)`
    : design.text;

  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: buildMessageContent(
        `${contextSection}Implement the following task:\n\n### Task ${task.number}: ${task.title}\n**Description**: ${task.description}\n**Acceptance Criteria**: ${task.acceptanceCriteria}\n**Example Code**:\n${task.exampleCode}\n\n---\n\nDesign context:\n${designContext}\n\nBegin implementation now. The project context above shows the current state — ensure your changes are consistent with existing files and the declared tech stack.`,
        design.images,
      ),
    },
  ];

  // Mark task as in_progress
  await updateTaskStatus(planFile, task.number, "in_progress");

  let summary: string;
  let filesWritten = 0;
  
  // Loop detection
  let lastToolCallSignature = "";
  let consecutiveIdenticalCalls = 0;

  // Tool-calling loop
  for (let i = 0; i < maxToolCallIterations; i++) {
    // Warn agent when approaching the iteration limit
    const iterationsLeft = maxToolCallIterations - i;
    if (iterationsLeft === Math.ceil(maxToolCallIterations * 0.2)) {
      messages.push({
        role: "user",
        content: `⚠️ URGENT: Only ${iterationsLeft} iterations remaining. If all required files are written and tests pass, call mark_task_complete NOW. Do not start new sub-tasks.`,
      });
    }

    // Trim conversation history if it gets too large (keep system + first user + last N turns)
    if (messages.length > 60) {
      const system = messages[0]!;
      const firstUser = messages[1]!;
      // Keep only the last 40 messages plus system + first user.
      // IMPORTANT: the slice must not start with a `tool` message — those require
      // a preceding `assistant` message with `tool_calls`. If an assistant+tools
      // batch straddles the cut point, advance past the orphaned tool messages so
      // the slice always begins at a clean turn boundary.
      let recentStart = messages.length - 40;
      while (recentStart < messages.length && messages[recentStart]!.role === "tool") {
        recentStart++;
      }
      const recent = messages.slice(recentStart);
      messages.length = 0;
      messages.push(system, firstUser, { role: "user", content: "(Earlier conversation trimmed to fit context window. Continue from the most recent state above.)" }, ...recent);
    }

    const response = await client.chat(messages, IMPL_TOOLS);
    usage = addTokenUsage(usage, response.usage);

    // Add assistant message to history
    messages.push({
      role: "assistant",
      content: response.content,
      toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
    });

    if (response.finishReason === "stop" || response.toolCalls.length === 0) {
      // No more tool calls — agent decided to stop without completing
      const msg = response.content?.trim();
      const iterationsLeft = maxToolCallIterations - i - 1;
      console.log(`    ⚠️  Agent returned stop with no tool calls (iteration ${i + 1}/${maxToolCallIterations})`);
      if (msg) console.log(`    💬 "${msg.slice(0, 200)}"`);
      // Nudge the model to continue rather than giving up
      messages.push({
        role: "user",
        content: `WARNING: You responded with text but no tool calls — that is not allowed. You have ${iterationsLeft} iteration(s) remaining.\n\nDo NOT narrate or describe. Respond with tool calls ONLY:\n- If the task is fully done (files written, tests pass), call mark_task_complete NOW.\n- If there is more to do, call the next tool immediately.`,
      });
      continue;
    }

    // Execute ALL tool calls in this batch before checking for completion
    let completionCall: { id: string; summary: string } | null = null;
    let interceptedLoop = false;

    // Loop detection check
    const currentSignature = JSON.stringify(response.toolCalls);
    if (currentSignature === lastToolCallSignature) {
      consecutiveIdenticalCalls++;
    } else {
      consecutiveIdenticalCalls = 0;
      lastToolCallSignature = currentSignature;
    }

    if (consecutiveIdenticalCalls >= 3) {
      // Intercept the call
      for (const toolCall of response.toolCalls) {
        messages.push({
          role: "tool",
          content: "Error: You are caught in a loop making the exact same tool calls. You must try a different approach or mark the task as complete/failed.",
          toolCallId: toolCall.id,
        });
      }
      interceptedLoop = true;
      console.log(`    ⚠️  Intercepted tool call loop`);
    }

    if (!interceptedLoop) {
      for (const toolCall of response.toolCalls) {
        if (toolCall.name === "mark_task_complete") {
          // Guard: refuse completion if no work has been done at all (no files exist in output dir)
          if (filesWritten === 0) {
            const entries = await fs.readdir(absOutputDir, { recursive: true }).catch(() => [] as string[]);
            const hasAnyFile = (entries as Array<string | Dirent>).some((e) =>
              typeof e === "string" ? !e.endsWith("/") : (e as Dirent).isFile(),
            );
            if (!hasAnyFile) {
              messages.push({
                role: "tool",
                content: "Error: Cannot mark task complete — no files exist in the output directory yet. Create files with write_file or run a scaffold command first.",
                toolCallId: toolCall.id,
              });
              console.log(`    ⚠️  Refused early mark_task_complete (output dir is empty)`);
              continue;
            }
          }
          completionCall = {
            id: toolCall.id,
            summary: (toolCall.arguments["summary"] as string) ?? "Task completed",
          };
          // Execute the underlying status update
          await executeTool(toolCall.name, toolCall.arguments, absOutputDir, planFile, task.number, commandTimeoutSecs);
          messages.push({
            role: "tool",
            content: "Task marked as completed.",
            toolCallId: toolCall.id,
          });
        } else {
          const result = await executeTool(toolCall.name, toolCall.arguments, absOutputDir, planFile, task.number, commandTimeoutSecs);
          if ((toolCall.name === "write_file" || toolCall.name === "replace_text") && !result.startsWith("Error")) {
            filesWritten++;
            console.log(`    💾 updated ${toolCall.arguments["path"]}`);
          } else if (toolCall.name === "run_command") {
            console.log(`    $ ${toolCall.arguments["command"]}`);
          } else {
            console.log(`    🔩 ${toolCall.name}(${JSON.stringify(toolCall.arguments).slice(0, 80)})`);
          }
          if (result.startsWith("Error")) {
            console.log(`    ❌ ${result.slice(0, 200)}`);
          }
          messages.push({
            role: "tool",
            content: result,
            toolCallId: toolCall.id,
          });
        }
      }
    }

    // After processing the full batch, return if task was completed
    if (completionCall) {
      summary = completionCall.summary;
      return { summary, usage };
    }
  }

  // If loop ended without mark_task_complete
  summary = "Implementation failed: Loop limit reached before completion.";
  return { summary, usage };
}

const fileBackupCache = new Map<string, string>();

/**
 * Resolve a path provided by the agent to an absolute path inside absOutputDir.
 * Handles the common mistake where the agent includes the output dir in the path
 * (e.g. "output/app/src/main.tsx" instead of "src/main.tsx").
 */
function resolveAgentPath(agentPath: string, absOutputDir: string): string {
  // If the agent gave us a path that, when resolved from CWD, lands inside absOutputDir, use it directly.
  const fromCwd = path.resolve(agentPath);
  if (fromCwd.startsWith(absOutputDir + path.sep) || fromCwd === absOutputDir) {
    return fromCwd;
  }
  // Normal case: treat as relative to absOutputDir.
  return path.join(absOutputDir, agentPath);
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  absOutputDir: string,
  planFile: string,
  taskNumber: number,
  commandTimeoutSecs = 120,
): Promise<string> {
  try {
    switch (name) {
      case "read_file": {
        const filePath = resolveAgentPath(String(args["path"] ?? ""), absOutputDir);
        const file = Bun.file(filePath);
        if (!(await file.exists())) return `Error: File not found: ${args["path"]}`;
        const content = await file.text();
        const CAP = 12_000;
        if (content.length > CAP) {
          return content.slice(0, CAP) + `\n... (truncated, ${content.length - CAP} chars omitted — use write_file or replace_text to modify the file)`;
        }
        return content;
      }

      case "write_file": {
        const relPath = String(args["path"] ?? "");
        const filePath = resolveAgentPath(relPath, absOutputDir);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        
        const file = Bun.file(filePath);
        if (await file.exists()) {
          fileBackupCache.set(relPath, await file.text());
        } else {
          fileBackupCache.set(relPath, "");
        }
        
        await Bun.write(filePath, String(args["content"] ?? ""));
        return `File written: ${relPath}`;
      }

      case "replace_text": {
        const relPath = String(args["path"] ?? "");
        const filePath = resolveAgentPath(relPath, absOutputDir);
        const oldStr = String(args["old_string"] ?? "");
        const newStr = String(args["new_string"] ?? "");
        
        const file = Bun.file(filePath);
        if (!(await file.exists())) return `Error: File not found: ${relPath}`;
        
        const content = await file.text();
        if (!content.includes(oldStr)) {
           return `Error: The exact old_string was not found in the file. Ensure you matched indentation and line breaks perfectly.`;
        }
        
        fileBackupCache.set(relPath, content);
        const newContent = content.replace(oldStr, newStr);
        await Bun.write(filePath, newContent);
        return `Text replaced in: ${relPath}`;
      }

      case "undo_edit": {
        const relPath = String(args["path"] ?? "");
        const backup = fileBackupCache.get(relPath);
        if (backup === undefined) {
          return `Error: No backup found for ${relPath}`;
        }
        const filePath = resolveAgentPath(relPath, absOutputDir);
        if (backup === "") {
          await fs.unlink(filePath).catch(() => {});
          return `File deleted (reverted to empty state): ${relPath}`;
        } else {
          await Bun.write(filePath, backup);
          return `File reverted to previous state: ${relPath}`;
        }
      }

      case "glob": {
        const pattern = String(args["pattern"] ?? "");
        const glob = new Bun.Glob(pattern);
        const results = [];
        for await (const file of glob.scan({ cwd: absOutputDir })) {
          results.push(file);
        }
        if (results.length === 0) return `No files found matching pattern: ${pattern}`;
        return results.join("\n");
      }

      case "grep_search": {
        const pattern = String(args["pattern"] ?? "");
        const dir = String(args["dir"] ?? ".");
        const dirPath = resolveAgentPath(dir, absOutputDir);
        const proc = Bun.spawn(["grep", "-rnE", pattern, "."], { cwd: dirPath, stdout: "pipe", stderr: "pipe" });
        const stdout = await new Response(proc.stdout).text();
        await proc.exited;
        if (!stdout) return `No matches found for: ${pattern}`;
        return stdout.slice(0, 5000) + (stdout.length > 5000 ? "\n... (truncated)" : "");
      }

      case "view_code_symbols": {
        const relPath = String(args["path"] ?? "");
        const filePath = resolveAgentPath(relPath, absOutputDir);
        const file = Bun.file(filePath);
        if (!(await file.exists())) return `Error: File not found: ${relPath}`;
        const content = await file.text();
        const lines = content.split("\n");
        const outline = lines.filter(l => /^(export )?(class|interface|function|const|let|var|type) /.test(l.trim()));
        if (outline.length === 0) return `No top-level symbols found in ${relPath}`;
        return outline.map(l => l.trim()).join("\n");
      }

      case "read_url": {
        const url = String(args["url"] ?? "");
        try {
          const res = await fetch(url);
          if (!res.ok) return `Error fetching URL: ${res.statusText}`;
          const text = await res.text();
          if (text.includes("<html") || text.includes("<!DOCTYPE")) {
             return text.replace(/<[^>]*>?/gm, " ").replace(/\s\s+/g, " ").slice(0, 10000) + "...\n(Truncated)";
          }
          return text.slice(0, 10000) + (text.length > 10000 ? "\n... (truncated)" : "");
        } catch (e) {
          return `Error: ${String(e)}`;
        }
      }

      case "list_directory": {
        const dirPath = resolveAgentPath(String(args["path"] ?? "."), absOutputDir);
        try {
          const entries = await fs.readdir(dirPath, { withFileTypes: true });
          return entries
            .map((e) => `${e.isDirectory() ? "[dir]" : "[file]"} ${e.name}`)
            .join("\n") || "(empty directory)";
        } catch {
          return `Error: Directory not found: ${args["path"]}`;
        }
      }

      case "run_command": {
        const command = String(args["command"] ?? "");

        // Reject long-running server/watch processes — they never exit and will
        // always time out. The harness starts the dev server itself after all
        // tasks are complete. Implementation tasks should only run build,
        // typecheck, test, and install commands.
        const BLOCKED_PATTERNS: Array<[RegExp, string]> = [
          // JS/TS dev scripts (Bun, npm, yarn, pnpm)
          [/\brun\s+dev\b/,                           "dev script"],
          [/\brun\s+start\b/,                         "start script"],
          [/\bnpm\s+start\b/,                         "npm start"],
          [/\bbun\s+dev\b/,                           "bun dev"],
          // Bundler dev servers
          [/\bvite(?!\s+(build|preview|--version))\b/, "Vite dev server"],
          [/\bwebpack(-dev-server|\s+serve)\b/,       "webpack dev server"],
          [/\bnext\s+(dev|start)\b/,                  "Next.js server"],
          [/\bnuxt\s+(dev|start|preview)\b/,          "Nuxt dev server"],
          [/\bgatsby\s+develop\b/,                    "Gatsby dev server"],
          [/\bparcel\s+(?!build)/,                    "Parcel dev server"],
          [/\brollup\s+.*--watch\b/,                  "Rollup watch"],
          [/\besbuild\s+.*--watch\b/,                 "esbuild watch"],
          // Static file servers
          [/\blive-server\b/,                         "live-server"],
          [/\bhttp-server\b/,                         "http-server"],
          [/\b(npx|bunx|pnpx)\s+serve\b/,            "serve (static server)"],
          [/^\s*serve\b/,                             "serve (static server)"],
          // Hot reload / watch daemons
          [/\bnodemon\b/,                             "nodemon"],
          [/--watch\b/,                               "watch mode"],
          [/--hot\b/,                                 "HMR / hot reload"],
          // .NET
          [/\bdotnet\s+(run|watch)\b/,                "dotnet run/watch"],
          // Go
          [/\bgo\s+run\b/,                            "go run"],
          [/\b(air|reflex|CompileDaemon|gin)\b/,      "Go hot-reload tool"],
          // Python
          [/\bflask\s+run\b/,                         "Flask dev server"],
          [/\buvicorn\b/,                             "Uvicorn ASGI server"],
          [/\bgunicorn\b/,                            "Gunicorn WSGI server"],
          [/\bmanage\.py\s+runserver\b/,              "Django runserver"],
          [/\bstreamlit\s+run\b/,                     "Streamlit server"],
          [/\bfastapi\s+dev\b/,                       "FastAPI dev server"],
          // Ruby
          [/\brails\s+(server|s)\b/,                  "Rails server"],
          [/\b(rackup|puma|unicorn)\b/,               "Ruby app server"],
          // PHP
          [/\bartisan\s+serve\b/,                     "Laravel artisan serve"],
          [/\bphp\s+-S\b/,                            "PHP built-in server"],
          // Java / JVM
          [/\bspring-boot:run\b/,                     "Spring Boot server"],
          [/\bbootRun\b/,                             "Spring Boot bootRun"],
          // Static site generators (serve/watch modes)
          [/\bhugo\s+(serve|server)\b/,               "Hugo server"],
          [/\bjekyll\s+serve\b/,                      "Jekyll server"],
          [/\bmkdocs\s+serve\b/,                      "MkDocs server"],
          [/\beleventy\s+.*(--serve|--watch)\b/,      "Eleventy server/watch"],
        ];
        const blocked = BLOCKED_PATTERNS.find(([p]) => p.test(command));
        if (blocked) {
          return (
            `Error: "${command}" starts a long-running ${blocked[1]} and is not allowed in implementation tasks. ` +
            `The harness starts the dev server automatically after all tasks complete. ` +
            `Use build/typecheck/test/install commands instead.`
          );
        }

        const TIMEOUT_MS = commandTimeoutSecs * 1_000;
        const proc = Bun.spawn(["/bin/sh", "-c", command], {
          cwd: absOutputDir,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env },
        });

        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, TIMEOUT_MS);

        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        clearTimeout(timer);

        if (timedOut) {
          return `Error: Command timed out after ${TIMEOUT_MS / 1000}s and was killed: ${command}`;
        }
        // Stdout: keep the tail (success messages appear at end, e.g. npm install summary).
        // Stderr: keep the head (first errors are most actionable).
        const MAX_STDOUT = 2_000;
        const MAX_STDERR = 1_500;
        const truncStdout = stdout.length > MAX_STDOUT
          ? `...(${stdout.length - MAX_STDOUT} chars omitted)\n` + stdout.slice(-MAX_STDOUT)
          : stdout;
        const truncStderr = stderr.length > MAX_STDERR
          ? stderr.slice(0, MAX_STDERR) + `\n...(${stderr.length - MAX_STDERR} chars omitted)`
          : stderr;
        return [
          `Exit code: ${exitCode}`,
          truncStdout ? `stdout:\n${truncStdout}` : "",
          truncStderr ? `stderr:\n${truncStderr}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      }

      case "mark_task_complete": {
        await updateTaskStatus(planFile, taskNumber, "completed");
        return "Task marked as completed.";
      }

      default:
        return `Error: Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error executing ${name}: ${String(err)}`;
  }
}
