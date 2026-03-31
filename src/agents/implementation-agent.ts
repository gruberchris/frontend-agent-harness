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
    description: "Write content to a file in the output directory (creates parent directories)",
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
): Promise<ImplementationAgentResult> {
  const client = new CopilotClient(model, reasoningEffort);
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

  let summary = "";

  // Tool-calling loop
  for (let i = 0; i < 50; i++) {
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

    // Execute each tool call
    for (const toolCall of response.toolCalls) {
      const result = await executeTool(toolCall.name, toolCall.arguments, absOutputDir, planFile, task.number);

      if (toolCall.name === "mark_task_complete") {
        summary = (toolCall.arguments["summary"] as string) ?? "Task completed";
        messages.push({
          role: "tool",
          content: "Task marked as completed.",
          toolCallId: toolCall.id,
        });
        return { summary, usage };
      }

      messages.push({
        role: "tool",
        content: result,
        toolCallId: toolCall.id,
      });
    }
  }

  // If loop ended without mark_task_complete, still mark it done
  await updateTaskStatus(planFile, task.number, "completed");
  return { summary, usage };
}

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
        return await file.text();
      }

      case "write_file": {
        const filePath = path.join(absOutputDir, String(args["path"] ?? ""));
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await Bun.write(filePath, String(args["content"] ?? ""));
        return `File written: ${args["path"]}`;
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
