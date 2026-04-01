import { addTokenUsage, emptyTokenUsage, type TokenUsage } from "../llm/types.ts";
import { getNextPendingTask, readPlanHeader } from "../plan/plan-parser.ts";
import { runImplementationAgent } from "./implementation-agent.ts";
import { type DesignContent } from "../design/design-loader.ts";
import { findBrokenReferences } from "../validation/reference-checker.ts";
import type { PlanTask } from "../plan/types.ts";
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

async function buildProjectContext(planFile: string, outputDir: string, memoryFile: string): Promise<string> {
  const parts: string[] = [];
  const absOutputDir = path.resolve(outputDir);

  // 1. Plan header (tech stack + conventions declared by Task Agent)
  const header = await readPlanHeader(planFile);
  if (header) {
    parts.push(`## Project Plan Header (Tech Stack & Conventions)\n${header}`);
  }

  // 1.5. Evaluator Memory (Lessons Learned)
  const memory = (await Bun.file(memoryFile).exists()) ? await Bun.file(memoryFile).text() : "";
  if (memory) {
    parts.push(`## Evaluator Memory & Previous Corrections\n${memory}`);
  }

  // 2. File tree of ./output/ (2 levels deep, max 60 entries, skip node_modules)
  const tree = await buildFileTree(absOutputDir, 2);
  parts.push(`## Current Output Directory Structure\n${tree || "(empty — no files yet)"}`);

  const context = parts.join("\n\n");

  // Hard cap on total context size sent per task (~30KB)
  const CONTEXT_CAP = 30_000;
  if (context.length > CONTEXT_CAP) {
    return context.slice(0, CONTEXT_CAP) + "\n\n... (project context truncated to fit context window)";
  }
  return context;
}

export async function runImplementationCoordinator(
  model: string,
  design: DesignContent,
  planFile: string,
  memoryFile: string,
  outputDir: string,
  systemPrompt: string,
  reasoningEffort?: string,
  maxTokens?: number,
  maxToolCallIterations?: number,
): Promise<CoordinatorResult> {
  let totalUsage = emptyTokenUsage();
  let tasksCompleted = 0;

  while (true) {
    const nextTask = await getNextPendingTask(planFile);

    if (!nextTask) {
      console.log(chalk.green("✅ All tasks in plan.md are completed."));
      break;
    }

    console.log(chalk.cyan(`\n▶️  Implementing Task ${nextTask.number}: ${nextTask.title}`));

    const projectContext = await buildProjectContext(planFile, outputDir, memoryFile);

    // Send design images only for the first task or visually-focused tasks.
    // Resending large base64 images on every task wastes significant tokens.
    const isUiTask = /layout|style|css|ui|visual|design|component|theme|color|icon/i.test(nextTask.title);
    const taskDesign: DesignContent = (tasksCompleted === 0 || isUiTask)
      ? design
      : { ...design, images: [] };

    const result = await runImplementationAgent(
      model,
      nextTask,
      taskDesign,
      planFile,
      outputDir,
      projectContext,
      systemPrompt,
      reasoningEffort,
      maxTokens,
      maxToolCallIterations,
    );

    totalUsage = addTokenUsage(totalUsage, result.usage);
    tasksCompleted++;

    console.log(chalk.green(`  ✅ Task ${nextTask.number} completed: ${result.summary}`));
  }

  // ── Post-implementation reference validation & repair ──────────────────────
  // Scan ALL generated files for broken local references (HTML src/href,
  // TS/JS imports, CSS @import). If any are found, run one targeted repair
  // task so the build doesn't fail on a trivial missing-file error.
  const absOutputDir = path.resolve(outputDir);
  const brokenRefs = await findBrokenReferences(absOutputDir);
  if (brokenRefs.length > 0) {
    const list = brokenRefs
      .map((r) => `- \`${r.missingFile}\` (referenced in \`${r.inFile}\`)`)
      .join("\n");
    console.log(chalk.yellow(`\n⚠️  Found ${brokenRefs.length} broken reference(s) — running repair pass...`));
    brokenRefs.forEach((r) => console.log(chalk.dim(`    missing: ${r.missingFile} ← ${r.inFile}`)));

    const repairTask: PlanTask = {
      number: tasksCompleted + 1,
      title: "Repair: Create missing referenced files",
      status: "pending",
      description:
        `The following files are referenced by the app but do not exist on disk:\n${list}\n\n` +
        `Read each referencing file to understand what the missing file should contain, then create it.`,
      acceptanceCriteria: "All referenced files exist and the app compiles without errors.",
      exampleCode: "",
      raw: "",
    };

    const repairContext = await buildProjectContext(planFile, outputDir, memoryFile);
    const repairResult = await runImplementationAgent(
      model,
      repairTask,
      { ...design, images: [] }, // no images needed for a repair pass
      planFile,
      outputDir,
      repairContext,
      systemPrompt,
      reasoningEffort,
      maxTokens,
      maxToolCallIterations,
    );

    totalUsage = addTokenUsage(totalUsage, repairResult.usage);
    tasksCompleted++;
    console.log(chalk.green(`  ✅ Repair pass: ${repairResult.summary}`));
  }

  return { tasksCompleted, usage: totalUsage };
}
