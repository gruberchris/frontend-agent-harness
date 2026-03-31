import { CopilotClient } from "../llm/copilot-client.ts";
import { addTokenUsage, emptyTokenUsage, type TokenUsage } from "../llm/types.ts";
import type { LLMMessage, ToolDefinition } from "../llm/types.ts";
import { updateTaskStatus } from "../plan/plan-parser.ts";
import type { PlanTask } from "../plan/types.ts";
import * as path from "node:path";
import * as fs from "node:fs/promises";

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
  task: PlanTask,
  designContent: string,
  planFile: string,
  outputDir: string,
  projectContext: string | undefined,
  systemPrompt: string,
  reasoningEffort?: string,
  maxTokens?: number,
  maxToolCallIterations = 20,
): Promise<ImplementationAgentResult> {
  const client = new CopilotClient(model, reasoningEffort, maxTokens);
  let usage = emptyTokenUsage();

  const absOutputDir = path.resolve(outputDir);
  await fs.mkdir(absOutputDir, { recursive: true });

  const contextSection = projectContext
    ? `## Project Context (pre-injected — use this to understand the current state)\n\n${projectContext}\n\n---\n\n`
    : "";

  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `${contextSection}Implement the following task:\n\n### Task ${task.number}: ${task.title}\n**Description**: ${task.description}\n**Acceptance Criteria**: ${task.acceptanceCriteria}\n**Example Code**:\n${task.exampleCode}\n\n---\n\nDesign context:\n${designContent}\n\nBegin implementation now. The project context above shows the current state — ensure your changes are consistent with existing files and the declared tech stack.`,
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
    // Trim conversation history if it gets too large (keep system + first user + last N turns)
    if (messages.length > 32) {
      const system = messages[0]!;
      const firstUser = messages[1]!;
      // Keep only the last 20 messages (10 assistant/tool pairs) plus system + first user
      const recent = messages.slice(-20);
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
      summary = response.content ?? "Task completed";
      break;
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
      console.log(`    ⚠  Intercepted tool call loop`);
    }

    if (!interceptedLoop) {
      for (const toolCall of response.toolCalls) {
        if (toolCall.name === "mark_task_complete") {
          // Guard: refuse completion if no files have been written yet
          if (filesWritten === 0) {
            messages.push({
              role: "tool",
              content: "Error: Cannot mark task complete — no files have been written yet. You must call write_file to create or update files before marking the task complete.",
              toolCallId: toolCall.id,
            });
            console.log(`    ⚠  Refused early mark_task_complete (no files written yet)`);
            continue;
          }
          completionCall = {
            id: toolCall.id,
            summary: (toolCall.arguments["summary"] as string) ?? "Task completed",
          };
          // Execute the underlying status update
          await executeTool(toolCall.name, toolCall.arguments, absOutputDir, planFile, task.number);
          messages.push({
            role: "tool",
            content: "Task marked as completed.",
            toolCallId: toolCall.id,
          });
        } else {
          const result = await executeTool(toolCall.name, toolCall.arguments, absOutputDir, planFile, task.number);
          if ((toolCall.name === "write_file" || toolCall.name === "replace_text") && !result.startsWith("Error")) {
            filesWritten++;
            console.log(`    📝 updated ${toolCall.arguments["path"]}`);
          } else if (toolCall.name === "run_command") {
            console.log(`    $ ${toolCall.arguments["command"]}`);
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

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  absOutputDir: string,
  planFile: string,
  taskNumber: number,
): Promise<string> {
  try {
    switch (name) {
      case "read_file": {
        const filePath = path.join(absOutputDir, String(args["path"] ?? ""));
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
        const filePath = path.join(absOutputDir, relPath);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        
        const file = Bun.file(filePath);
        if (await file.exists()) {
          fileBackupCache.set(relPath, await file.text());
        } else {
          fileBackupCache.set(relPath, "");
        }
        
        await Bun.write(filePath, String(args["content"] ?? ""));
        
        if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) {
          const proc = Bun.spawn(["bun", "build", filePath, "--no-bundle"], { stdout: "pipe", stderr: "pipe" });
          const exitCode = await proc.exited;
          if (exitCode !== 0) {
            const stderr = await new Response(proc.stderr).text();
            const backup = fileBackupCache.get(relPath) ?? "";
            if (backup) {
              await Bun.write(filePath, backup);
            } else {
              await fs.unlink(filePath);
            }
            return `Error: Syntax error detected. File write reverted.\n${stderr}`;
          }
        }
        return `File written: ${relPath}`;
      }

      case "replace_text": {
        const relPath = String(args["path"] ?? "");
        const filePath = path.join(absOutputDir, relPath);
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
        
        if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) {
          const proc = Bun.spawn(["bun", "build", filePath, "--no-bundle"], { stdout: "pipe", stderr: "pipe" });
          const exitCode = await proc.exited;
          if (exitCode !== 0) {
            const stderr = await new Response(proc.stderr).text();
            await Bun.write(filePath, content);
            return `Error: Syntax error detected after replacement. File edit reverted.\n${stderr}`;
          }
        }
        return `Text replaced in: ${relPath}`;
      }

      case "undo_edit": {
        const relPath = String(args["path"] ?? "");
        const backup = fileBackupCache.get(relPath);
        if (backup === undefined) {
          return `Error: No backup found for ${relPath}`;
        }
        const filePath = path.join(absOutputDir, relPath);
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
        const dirPath = path.join(absOutputDir, dir);
        const proc = Bun.spawn(["grep", "-rnE", pattern, "."], { cwd: dirPath, stdout: "pipe", stderr: "pipe" });
        const stdout = await new Response(proc.stdout).text();
        await proc.exited;
        if (!stdout) return `No matches found for: ${pattern}`;
        return stdout.slice(0, 5000) + (stdout.length > 5000 ? "\n... (truncated)" : "");
      }

      case "view_code_symbols": {
        const relPath = String(args["path"] ?? "");
        const filePath = path.join(absOutputDir, relPath);
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
        const dirPath = path.join(absOutputDir, String(args["path"] ?? "."));
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
        const proc = Bun.spawn(["bash", "-c", command], {
          cwd: absOutputDir,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return [
          `Exit code: ${exitCode}`,
          stdout ? `stdout:\n${stdout}` : "",
          stderr ? `stderr:\n${stderr}` : "",
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
