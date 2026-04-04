import { runTaskAgent } from "../agents/task-agent.ts";
import { runImplementationCoordinator } from "../agents/implementation-coordinator.ts";
import { runEvaluatorAgent } from "../agents/evaluator-agent.ts";
import { startDevServer } from "../server/dev-server.ts";
import { printReport, type AgentStepStats, type PipelineReport } from "./reporting.ts";
import { addTokenUsage, emptyTokenUsage } from "../llm/types.ts";
import { loadDesignContent } from "../design/design-loader.ts";
import { readTasks, updateTaskStatus } from "../plan/plan-parser.ts";
import type { HarnessConfig } from "../config.ts";
import chalk from "chalk";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const activeHandles: Set<{ stop: () => Promise<void> }> = new Set();

async function clearDirectory(dir: string): Promise<void> {
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    entries.map((e) => fs.rm(path.join(dir, e), { recursive: true, force: true })),
  );
}

async function readFileTree(dir: string, depth = 0, maxDepth = 3): Promise<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const lines: string[] = [];
  const indent = "  ".repeat(depth);
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    lines.push(`${indent}${e.isDirectory() ? e.name + "/" : e.name}`);
    if (e.isDirectory() && depth < maxDepth) {
      lines.push(await readFileTree(path.join(dir, e.name), depth + 1, maxDepth));
    }
  }
  return lines.filter(Boolean).join("\n");
}

async function cleanup() {
  for (const handle of activeHandles) {
    try {
      await handle.stop();
    } catch {}
  }
}

process.on("SIGINT", async () => {
  console.log("\nCaught interrupt signal. Cleaning up processes...");
  await cleanup();
  process.exit(1);
});

process.on("unhandledRejection", async (err) => {
  console.error("Unhandled Rejection:", err);
  await cleanup();
  process.exit(1);
});

export async function runHarness(config: HarnessConfig): Promise<PipelineReport> {
  const startTime = Date.now();
  const steps: AgentStepStats[] = [];
  let totalIterations = 0;
  let result: "SUCCESS" | "FAILURE" = "FAILURE";
  let resultReason = "";

  // ── Read design.md ──────────────────────────────────────────────────────────
  const designFile = Bun.file(config.designFile);
  if (!(await designFile.exists())) {
    throw new Error(`Design file not found: ${config.designFile}`);
  }
  const design = await loadDesignContent(config.designFile);

  console.log(chalk.bold(`\n🚀 Frontend Design Agent Harness`));
  console.log(chalk.dim(`Design: ${config.designFile}`));
  console.log(chalk.dim(`Plan:   ${config.planFile}`));
  console.log(chalk.dim(`Memory: ${config.memoryFile}`));
  console.log(chalk.dim(`App:    ${config.appDir}`));
  console.log(chalk.dim(`Output: ${config.outputDir}`));
  console.log(chalk.dim(`Max iterations: ${config.maxEvaluatorIterations}\n`));

  // ── Startup: resume from plan.md or start fresh ─────────────────────────────
  const planFile = Bun.file(config.planFile);
  const planExists = (await planFile.exists()) && (await planFile.text()).trim().length > 0;

  let taskAgentUsage = emptyTokenUsage();
  let taskAgentCalls = 0;

  if (planExists) {
    // On re-run, the task agent re-assigns all incomplete tasks (failed, in_progress,
    // or never-started pending) back to "pending" in task-number order, so the
    // coordinator processes them cleanly from lowest to highest regardless of whatever
    // status they had when the previous run ended.
    const existingTasks = await readTasks(config.planFile);
    const incompleteTasks = existingTasks.filter((t) => t.status !== "completed");

    if (incompleteTasks.length > 0) {
      console.log(
        chalk.bold(
          `📋 Existing plan.md found — re-assigning ${incompleteTasks.length} incomplete task(s) in order.`,
        ),
      );
      for (const task of incompleteTasks) {
        await updateTaskStatus(config.planFile, task.number, "pending");
        console.log(chalk.dim(`   Task ${task.number}: ${task.title} (was: ${task.status})`));
      }
    } else {
      console.log(chalk.bold("📋 Existing plan.md found — all tasks already completed."));
    }
    console.log(chalk.dim(`   (Delete ${config.planFile} to start fresh)\n`));
  } else {
    console.log(chalk.bold("📐 Step 1: Task Agent — generating plan.md..."));
    console.log(chalk.dim(`   (No plan.md found — clearing output dir and starting fresh)\n`));
    await clearDirectory(path.resolve(config.outputDir));

    const taskResult = await runTaskAgent(
      config.agents.taskAgent.model,
      config.provider,
      design,
      config.planFile,
      config.memoryFile,
      config.agents.taskAgent.systemPrompt,
      config.agents.taskAgent.reasoningEffort,
      config.agents.taskAgent.maxTokens,
      undefined,
      config.llmTimeoutSecs,
      undefined,
      undefined,
      config.llmStreamTimeoutSecs,
    );
    taskAgentUsage = addTokenUsage(taskAgentUsage, taskResult.usage);
    taskAgentCalls++;
    console.log(chalk.green(`✅ plan.md generated`));
  }

  // ── Start dev server ─────────────────────────────────────────────────────────
  let devServerHandle: Awaited<ReturnType<typeof startDevServer>> | null = null;
  const appUrl = `http://localhost:${config.devServer.port}`;

  // ── Iteration loop ───────────────────────────────────────────────────────────
  let implCoordUsage = emptyTokenUsage();
  let implCoordCalls = 0;
  let evaluatorUsage = emptyTokenUsage();
  let evaluatorCalls = 0;

  for (let iteration = 1; iteration <= config.maxEvaluatorIterations; iteration++) {
    totalIterations = iteration;
    console.log(chalk.bold(`\n🏗️  Step 2 (iteration ${iteration}): Implementation...`));

    // ── Step 2: Implementation Coordinator ──────────────────────────────────
    const coordResult = await runImplementationCoordinator(
      config.agents.implementationAgent.model,
      config.provider,
      design, // re-use loaded design (images already in memory)
      config.planFile,
      config.appDir,
      config.agents.implementationAgent.systemPrompt,
      config.agents.implementationAgent.reasoningEffort,
      config.agents.implementationAgent.maxTokens,
      config.maxToolCallIterations,
      config.commandTimeoutSecs,
      config.llmTimeoutSecs,
      config.projectContextChars,
      config.historyTrimThreshold,
      config.historyTrimKeep,
      config.agents.implementationAgent.parallelToolCalls,
      config.agents.implementationAgent.frequencyPenalty,
      config.maxTaskRetries,
      config.llmStreamTimeoutSecs,
      config.maxConsecutiveLoops,
    );
    implCoordUsage = addTokenUsage(implCoordUsage, coordResult.usage);
    implCoordCalls += coordResult.tasksCompleted;

    // ── Guard: abort if a task permanently failed ────────────────────────────
    if (coordResult.permanentlyFailedTask) {
      const { number, title } = coordResult.permanentlyFailedTask;
      console.log();
      console.log(
        chalk.red(
          `❌ Task ${number} ("${title}") permanently failed after ${config.maxTaskRetries} attempt(s). Pipeline cannot continue.`,
        ),
      );
      result = "FAILURE";
      resultReason = `Task ${number} ("${title}") permanently failed after ${config.maxTaskRetries} attempt(s) without completing.`;
      break;
    }

    console.log(
      chalk.green(`✅ Implementation complete (${coordResult.tasksCompleted} tasks done)`),
    );

    // ── Start/restart dev server ────────────────────────────────────────────
    if (devServerHandle) {
      activeHandles.delete(devServerHandle);
      await devServerHandle.stop();
    }
    console.log(chalk.bold(`\n🖥️  Starting dev server at ${appUrl}...`));
    let devServerError: string | undefined;
    try {
      devServerHandle = await startDevServer(
        config.appDir,
        config.devServer.startCommand,
        config.devServer.port,
      );
      activeHandles.add(devServerHandle);
      console.log(chalk.green(`✅ Dev server running at ${appUrl}`));
    } catch (err) {
      devServerError = String(err);
      console.warn(chalk.yellow(`⚠️  Could not start dev server: ${devServerError}`));
    }

    // ── Step 3: Evaluator Agent ──────────────────────────────────────────────
    console.log(chalk.bold(`\n🧪 Step 3 (iteration ${iteration}): Evaluator Agent...`));
    const currentDesign = await Bun.file(config.designFile).text();

    const evalResult = await runEvaluatorAgent(
      config.agents.evaluatorAgent.model,
      config.provider,
      appUrl,
      currentDesign,
      config.planFile,
      config.designFile,
      config.memoryFile,
      config.outputDir,
      config.playwright.browser,
      config.playwright.headless,
      config.agents.evaluatorAgent.systemPrompt,
      config.agents.evaluatorAgent.reasoningEffort,
      config.agents.evaluatorAgent.maxTokens,
      devServerError,
      config.llmTimeoutSecs,
      config.maxToolCallIterations,
      config.llmStreamTimeoutSecs,
    );
    evaluatorUsage = addTokenUsage(evaluatorUsage, evalResult.usage);
    evaluatorCalls++;

    if (evalResult.decision === "PASS") {
      result = "SUCCESS";
      resultReason = evalResult.explanation;
      console.log();
      console.log(chalk.green(`✅ Evaluator: PASS — ${evalResult.explanation}`));
      break;
    }

    console.log();
    console.log(chalk.yellow(`⚠️  Evaluator: NEEDS_WORK — ${evalResult.explanation}`));

    if (iteration >= config.maxEvaluatorIterations) {
      result = "FAILURE";
      resultReason = `Max iterations (${config.maxEvaluatorIterations}) reached. Last issue: ${evalResult.explanation}`;
      console.log(chalk.red(`❌ Max iterations reached. Pipeline terminating.`));
      break;
    }

    // ── Re-run Task Agent in correction mode ─────────────────────────────────
    // Append targeted correction tasks to the EXISTING plan instead of replacing
    // it. This preserves all completed work — only the new failing issues get
    // new pending tasks that the coordinator will pick up.
    console.log(chalk.bold(`\n🔄 Appending correction tasks based on evaluator feedback...`));

    const existingTasks = await readTasks(config.planFile);
    const nextTaskNumber = (existingTasks.length > 0 ? Math.max(...existingTasks.map((t) => t.number)) : 0) + 1;
    const existingFileTree = await readFileTree(path.resolve(config.appDir));

    const reTaskResult = await runTaskAgent(
      config.agents.taskAgent.model,
      config.provider,
      design,
      config.planFile,
      config.memoryFile,
      config.agents.taskAgent.systemPrompt,
      config.agents.taskAgent.reasoningEffort,
      config.agents.taskAgent.maxTokens,
      existingFileTree,
      config.llmTimeoutSecs,
      true, // correctionMode — appends tasks instead of replacing the plan
      nextTaskNumber,
      config.llmStreamTimeoutSecs,
    );
    taskAgentUsage = addTokenUsage(taskAgentUsage, reTaskResult.usage);
    taskAgentCalls++;
    console.log(chalk.green(`✅ Correction tasks appended to plan.md (starting at Task ${nextTaskNumber})`));
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────────
  if (devServerHandle) {
    activeHandles.delete(devServerHandle);
    await devServerHandle.stop();
  }

  // ── Build report ─────────────────────────────────────────────────────────────
  steps.push({ name: "Task Agent", usage: taskAgentUsage, callCount: taskAgentCalls });
  steps.push({
    name: "Implementation Agent",
    usage: implCoordUsage,
    callCount: implCoordCalls,
  });
  steps.push({ name: "Evaluator Agent", usage: evaluatorUsage, callCount: evaluatorCalls });

  const report: PipelineReport = {
    steps,
    totalIterations,
    elapsedMs: Date.now() - startTime,
    result,
    resultReason,
  };

  printReport(report);
  return report;
}
