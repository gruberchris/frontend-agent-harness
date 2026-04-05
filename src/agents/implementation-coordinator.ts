import { addTokenUsage, emptyTokenUsage, type TokenUsage } from "../llm/types.ts";
import { getNextPendingTask, readPlanHeader, updateTaskStatus } from "../plan/plan-parser.ts";
import { runImplementationAgent } from "./implementation-agent.ts";
import { type DesignContent } from "../design/design-loader.ts";
import type { ProviderConfig } from "../llm/provider.ts";
import type { PlanTask } from "../plan/types.ts";
import chalk from "chalk";
import * as path from "node:path";
import * as fs from "node:fs/promises";

export interface CoordinatorResult {
  tasksCompleted: number;
  usage: TokenUsage;
  /** Set when a task permanently fails after exhausting all retry attempts. */
  permanentlyFailedTask?: { number: number; title: string };
}

async function buildFileTree(
  absDir: string,
  maxDepth: number,
  depth = 0,
  limit = { count: 0 },
): Promise<string> {
  try {
    const entries = await fs.readdir(absDir, { withFileTypes: true });
    const lines: string[] = [];
    const indent = "  ".repeat(depth);

    for (const entry of entries) {
      if (limit.count >= 60) {
        lines.push(`${indent}... (truncated)`);
        break;
      }
      if (entry.name === "node_modules" || entry.name === ".git") continue;

      limit.count++;
      if (entry.isDirectory()) {
        lines.push(`${indent}${entry.name}/`);
        if (depth < maxDepth) {
          const children = await buildFileTree(
            path.join(absDir, entry.name),
            maxDepth,
            depth + 1,
            limit,
          );
          if (children) lines.push(children);
        }
      } else {
        lines.push(`${indent}${entry.name}`);
      }
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

async function readFileCapped(filePath: string, cap = 3_000): Promise<string | null> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;
  const text = await file.text();
  return text.length > cap ? text.slice(0, cap) + "\n... (truncated)" : text;
}

async function buildProjectContext(planFile: string, outputDir: string, task?: PlanTask, contextCap = 50_000): Promise<string> {
  const parts: string[] = [];
  const absOutputDir = path.resolve(outputDir);

  // 1. Plan header (tech stack + conventions declared by Task Agent)
  const header = await readPlanHeader(planFile);
  if (header) {
    parts.push(`## Project Plan Header (Tech Stack & Conventions)\n${header}`);
  }

  // 2. File tree of ./output/ (2 levels deep, max 60 entries, skip node_modules)
  const tree = await buildFileTree(absOutputDir, 2);
  parts.push(`## Current Output Directory Structure\n${tree || "(empty — no files yet)"}`);

  // 3. Smart Key File Contents — prioritize core configs and task-related files
  const SKIP_DIRS = new Set([
    "node_modules", "dist", "build", "bin", "obj", ".git", ".vite", "coverage", "__pycache__", ".idea", ".vscode"
  ]);
  const EXCLUDE_FILES = new Set([
    "README.md", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock", ".env.example", ".gitignore"
  ]);
  const ALWAYS_INCLUDE = new Set([
    "package.json", "tsconfig.json", "vite.config.ts", "tailwind.config.ts", "tailwind.config.js", "next.config.js", "index.html"
  ]);

  const keyParts: string[] = [];
  const taskKeywords = new Set<string>();
  if (task) {
    const text = `${task.title} ${task.description}`.toLowerCase();
    // Extract potential filenames or component names
    const words = text.match(/[a-z0-9.-]+/g) || [];
    for (const w of words) {
      if (w.length > 3) taskKeywords.add(w);
    }
  }

  async function gatherFiles(dir: string, relDir: string, depth: number): Promise<{relPath: string, path: string, isPriority: boolean}[]> {
    if (depth > 2) return []; // limit recursion depth
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    let files: {relPath: string, path: string, isPriority: boolean}[] = [];
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) {
          const subFiles = await gatherFiles(path.join(dir, e.name), relDir ? `${relDir}/${e.name}` : e.name, depth + 1);
          files = files.concat(subFiles);
        }
      } else if (e.isFile()) {
        if (EXCLUDE_FILES.has(e.name) || e.name.endsWith(".lock") || e.name.endsWith(".png") || e.name.endsWith(".jpg") || e.name.endsWith(".ico") || e.name.endsWith(".svg")) continue;
        
        const relPath = relDir ? `${relDir}/${e.name}` : e.name;
        const isCore = ALWAYS_INCLUDE.has(e.name);
        const nameLower = e.name.toLowerCase();
        let isTaskRelated = false;
        
        // Check if filename matches any task keyword
        const nameNoExt = nameLower.split('.')[0] || nameLower;
        if (taskKeywords.has(nameNoExt)) {
          isTaskRelated = true;
        }

        files.push({ relPath, path: path.join(dir, e.name), isPriority: isCore || isTaskRelated });
      }
    }
    return files;
  }

  const allFiles = await gatherFiles(absOutputDir, "", 0);
  
  // Sort: Priority files first, then root files, then alphabetize
  allFiles.sort((a, b) => {
    if (a.isPriority && !b.isPriority) return -1;
    if (!a.isPriority && b.isPriority) return 1;
    
    const aIsRoot = !a.relPath.includes("/");
    const bIsRoot = !b.relPath.includes("/");
    if (aIsRoot && !bIsRoot) return -1;
    if (!aIsRoot && bIsRoot) return 1;
    
    return a.relPath.localeCompare(b.relPath);
  });

  // Take top N files to fit within a reasonable number before context cap
  for (const file of allFiles.slice(0, 15)) {
    const cap = file.isPriority ? 3_000 : 1_000;
    const content = await readFileCapped(file.path, cap);
    if (content !== null) {
      keyParts.push(`**${file.relPath}**\n\`\`\`\n${content}\n\`\`\``);
    }
  }

  if (keyParts.length > 0) {
    parts.push(`## Key File Contents\n${keyParts.join("\n\n")}`);
  }

  const context = parts.join("\n\n");

  if (context.length > contextCap) {
    return context.slice(0, contextCap) + "\n\n... (project context truncated to fit context window)";
  }
  return context;
}

export async function runImplementationCoordinator(
  model: string,
  providerConfig: ProviderConfig,
  design: DesignContent,
  planFile: string,
  outputDir: string,
  systemPrompt: string,
  reasoningEffort?: string,
  maxTokens?: number,
  maxToolCallIterations?: number,
  commandTimeoutSecs?: number,
  llmTimeoutSecs?: number,
  projectContextChars?: number,
  historyTrimThreshold?: number,
  historyTrimKeep?: number,
  parallelToolCalls?: boolean,
  frequencyPenalty?: number,
  maxTaskRetries = 2,
  llmStreamTimeoutSecs?: number,
  maxConsecutiveLoops?: number,
): Promise<CoordinatorResult> {
  let totalUsage = emptyTokenUsage();
  let tasksCompleted = 0;
  let permanentlyFailedTask: CoordinatorResult["permanentlyFailedTask"];

  // Tracks how many times each task (by number) has been attempted.
  const retryCount = new Map<number, number>();

  while (true) {
    const nextTask = await getNextPendingTask(planFile);

    if (!nextTask) {
      console.log();
      console.log(chalk.green("✅ All tasks in plan.md are completed."));
      break;
    }

    const attempts = retryCount.get(nextTask.number) ?? 0;

    // Mark in_progress before each attempt (including retries) so that "failed"
    // is cleared from plan.md while the agent is actively working. This ensures
    // only one task — the permanently failed one — is ever left in the "failed" state.
    await updateTaskStatus(planFile, nextTask.number, "in_progress");

    const attemptLabel = attempts === 0 ? "" : ` (retry ${attempts}/${maxTaskRetries - 1})`;
    console.log(chalk.cyan(`\n▶️  Implementing Task ${nextTask.number}: ${nextTask.title}${attemptLabel}`));

    const projectContext = await buildProjectContext(planFile, outputDir, nextTask, projectContextChars);

    // Send design images only for the first task or visually focused tasks.
    // Resending large base64 images on every task wastes significant tokens.
    const isUiTask = /layout|style|css|ui|visual|design|component|theme|color|icon/i.test(nextTask.title);
    const taskDesign: DesignContent = (tasksCompleted === 0 || isUiTask)
      ? design
      : { ...design, images: [] };

    const result = await runImplementationAgent(
      model,
      providerConfig,
      nextTask,
      taskDesign,
      planFile,
      outputDir,
      projectContext,
      systemPrompt,
      reasoningEffort,
      maxTokens,
      maxToolCallIterations,
      commandTimeoutSecs,
      llmTimeoutSecs,
      historyTrimThreshold,
      historyTrimKeep,
      parallelToolCalls,
      frequencyPenalty,
      llmStreamTimeoutSecs,
      maxConsecutiveLoops,
    );

    totalUsage = addTokenUsage(totalUsage, result.usage);

    const failed = result.summary.startsWith("Implementation failed");
    if (failed) {
      const newAttempts = attempts + 1;
      retryCount.set(nextTask.number, newAttempts);

      if (newAttempts >= maxTaskRetries) {
        // Task has exhausted all retry attempts — leave it as "failed" in plan.md
        // (the implementation agent already set it). Break immediately; no further
        // tasks run, so this is the only task that will ever be permanently "failed".
        console.log(
          chalk.red(
            `  ❌ Task ${nextTask.number} permanently failed after ${newAttempts} attempt(s): ${result.summary}`,
          ),
        );
        permanentlyFailedTask = { number: nextTask.number, title: nextTask.title };
        break;
      }

      console.log(
        chalk.yellow(
          `  ⚠️  Task ${nextTask.number} incomplete (attempt ${newAttempts}/${maxTaskRetries}): ${result.summary}`,
        ),
      );
      // Task is now "failed" in plan.md; getNextPendingTask will return it again
      // on the next loop iteration for an immediate retry.
    } else {
      tasksCompleted++;
      console.log(chalk.green(`  ✅ Task ${nextTask.number} completed: ${result.summary}`));
    }
  }

  return { tasksCompleted, usage: totalUsage, permanentlyFailedTask };
}
