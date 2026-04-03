import { addTokenUsage, emptyTokenUsage, type TokenUsage } from "../llm/types.ts";
import { getNextPendingTask, readPlanHeader, readTasks, appendTasks } from "../plan/plan-parser.ts";
import { runImplementationAgent } from "./implementation-agent.ts";
import { type DesignContent } from "../design/design-loader.ts";
import { findBrokenReferences } from "../validation/reference-checker.ts";
import type { PlanTask } from "../plan/types.ts";
import type { ProviderConfig } from "../llm/provider.ts";
import chalk from "chalk";
import * as path from "node:path";
import * as fs from "node:fs/promises";

export interface CoordinatorResult {
  tasksCompleted: number;
  usage: TokenUsage;
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

async function buildProjectContext(planFile: string, outputDir: string, contextCap = 50_000): Promise<string> {
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

  // 3. Key file contents — injected upfront so the agent doesn't burn tool-call
  //    iterations reading the same files on every task.
  //    Tech-agnostic: reads whatever small files exist at the root and in immediate
  //    subdirectories. Works for React/Vite, ASP.NET, Go, static HTML, etc.
  const SKIP_DIRS = new Set([
    "node_modules", "dist", "build", "bin", "obj", ".git", ".vite", "coverage", "__pycache__",
  ]);
  const keyParts: string[] = [];

  const rootEntries = await fs.readdir(absOutputDir, { withFileTypes: true }).catch(() => []);

  // Root-level files (project configs, manifests, entry points, etc.)
  for (const entry of rootEntries.filter((e) => e.isFile()).slice(0, 12)) {
    const content = await readFileCapped(path.join(absOutputDir, entry.name), 2_000);
    if (content !== null) keyParts.push(`**${entry.name}**\n\`\`\`\n${content}\n\`\`\``);
  }

  // Files in immediate non-excluded subdirectories (e.g. src/, pages/, wwwroot/)
  const subDirs = rootEntries
    .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
    .slice(0, 4);
  for (const dir of subDirs) {
    const dirPath = path.join(absOutputDir, dir.name);
    const subEntries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const entry of subEntries.filter((e) => e.isFile()).slice(0, 6)) {
      const rel = `${dir.name}/${entry.name}`;
      const content = await readFileCapped(path.join(dirPath, entry.name), 1_500);
      if (content !== null) keyParts.push(`**${rel}**\n\`\`\`\n${content}\n\`\`\``);
    }

    // One extra level deep for any nested subdirectory (e.g. src/utils/, src/hooks/, src/components/).
    // Use a smaller per-file cap — enough to show exports/signatures — since deeper files are more
    // numerous. The total contextCap applied at the end still bounds the overall size.
    const deepFileCap = Math.max(300, Math.floor(contextCap / 40));
    for (const subEntry of subEntries.filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name)).slice(0, 4)) {
      const subDirPath = path.join(dirPath, subEntry.name);
      const deepEntries = await fs.readdir(subDirPath, { withFileTypes: true }).catch(() => []);
      for (const deepEntry of deepEntries.filter((e) => e.isFile()).slice(0, 6)) {
        const rel = `${dir.name}/${subEntry.name}/${deepEntry.name}`;
        const content = await readFileCapped(path.join(subDirPath, deepEntry.name), deepFileCap);
        if (content !== null) keyParts.push(`**${rel}**\n\`\`\`\n${content}\n\`\`\``);
      }
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
): Promise<CoordinatorResult> {
  let totalUsage = emptyTokenUsage();
  let tasksCompleted = 0;

  while (true) {
    const nextTask = await getNextPendingTask(planFile);

    if (!nextTask) {
      console.log();
      console.log(chalk.green("✅ All tasks in plan.md are completed."));
      break;
    }

    console.log(chalk.cyan(`\n▶️  Implementing Task ${nextTask.number}: ${nextTask.title}`));

    const projectContext = await buildProjectContext(planFile, outputDir, projectContextChars);

    // Send design images only for the first task or visually-focused tasks.
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
    );

    totalUsage = addTokenUsage(totalUsage, result.usage);
    tasksCompleted++;

    const failed = result.summary.startsWith("Implementation failed");
    if (failed) {
      console.log(chalk.yellow(`  ⚠️  Task ${nextTask.number} incomplete: ${result.summary}`));
    } else {
      console.log(chalk.green(`  ✅ Task ${nextTask.number} completed: ${result.summary}`));
    }
  }

  // ── Post-implementation reference validation & repair ──────────────────────
  // Scan ALL generated files for broken local references (HTML src/href,
  // TS/JS imports, CSS @import). If any are found, append a repair task to
  // plan.md and run the implementation agent so status updates work correctly.
  const absOutputDir = path.resolve(outputDir);
  const brokenRefs = await findBrokenReferences(absOutputDir);
  if (brokenRefs.length > 0) {
    const list = brokenRefs
      .map((r) => `- \`${r.missingFile}\` (referenced in \`${r.inFile}\`)`)
      .join("\n");
    console.log(chalk.yellow(`\n⚠️  Found ${brokenRefs.length} broken reference(s) — running repair pass...`));
    brokenRefs.forEach((r) => console.log(chalk.dim(`    missing: ${r.missingFile} ← ${r.inFile}`)));

    // Derive task number from actual plan so we don't conflict with existing tasks
    const existingTasks = await readTasks(planFile);
    const repairNumber = existingTasks.reduce((max, t) => Math.max(max, t.number), 0) + 1;

    const repairTask: PlanTask = {
      number: repairNumber,
      title: "Repair: Create missing referenced files",
      status: "pending",
      description:
        `The following files are referenced by the app but do not exist on disk:\n${list}\n\n` +
        `Read each referencing file to understand what the missing file should contain, then create it.`,
      acceptanceCriteria: "All referenced files exist and the app compiles without errors.",
      exampleCode: "",
      raw: "",
    };

    // Append repair task to plan.md so updateTaskStatus can find it
    const repairBlock = [
      `### Task ${repairTask.number}: ${repairTask.title}`,
      `**Status**: pending`,
      `**Description**: ${repairTask.description}`,
      `**Acceptance Criteria**: ${repairTask.acceptanceCriteria}`,
      `**Example Code**:`,
      "```",
      "",
      "```",
    ].join("\n");
    await appendTasks(planFile, repairBlock);

    const repairContext = await buildProjectContext(planFile, outputDir, projectContextChars);
    const repairResult = await runImplementationAgent(
      model,
      providerConfig,
      repairTask,
      { ...design, images: [] }, // no images needed for a repair pass
      planFile,
      outputDir,
      repairContext,
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
    );

    totalUsage = addTokenUsage(totalUsage, repairResult.usage);
    tasksCompleted++;
    console.log(chalk.green(`  ✅ Repair pass: ${repairResult.summary}`));
  }

  return { tasksCompleted, usage: totalUsage };
}
