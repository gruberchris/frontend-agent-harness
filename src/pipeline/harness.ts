import { runTaskAgent } from "../agents/task-agent.ts";
import { runImplementationCoordinator } from "../agents/implementation-coordinator.ts";
import { runEvaluatorAgent } from "../agents/evaluator-agent.ts";
import { startDevServer } from "../server/dev-server.ts";
import { printReport, type AgentStepStats, type PipelineReport } from "./reporting.ts";
import { addTokenUsage, emptyTokenUsage } from "../llm/types.ts";
import type { HarnessConfig } from "../config.ts";
import chalk from "chalk";

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

  console.log(chalk.bold(`\n🚀 Frontend Design Agent Harness`));
  console.log(chalk.dim(`Design: ${config.designFile}`));
  console.log(chalk.dim(`Plan:   ${config.planFile}`));
  console.log(chalk.dim(`Memory: ${config.memoryFile}`));
  console.log(chalk.dim(`Output: ${config.outputDir}`));
  console.log(chalk.dim(`Max iterations: ${config.maxEvaluatorIterations}\n`));

  // ── Step 1: Task Agent (initial plan) ───────────────────────────────────────
  console.log(chalk.bold("📋 Step 1: Task Agent — generating plan.md..."));
  const designContent = await designFile.text();

  let taskAgentUsage = emptyTokenUsage();
  let taskAgentCalls = 0;

  const taskResult = await runTaskAgent(
    config.agents.taskAgent.model,
    designContent,
    config.planFile,
    config.memoryFile,
    config.agents.taskAgent.systemPrompt,
    config.agents.taskAgent.reasoningEffort,
    config.agents.taskAgent.maxTokens,
  );
  taskAgentUsage = addTokenUsage(taskAgentUsage, taskResult.usage);
  taskAgentCalls++;

  console.log(chalk.green(`✓ plan.md generated`));

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
    console.log(chalk.bold(`\n🔨 Step 2 (iteration ${iteration}): Implementation...`));

    // ── Step 2: Implementation Coordinator ──────────────────────────────────
    const coordResult = await runImplementationCoordinator(
      config.agents.implementationAgent.model,
      await Bun.file(config.designFile).text(), // re-read original design (now kept pristine)
      config.planFile,
      config.memoryFile,
      config.outputDir,
      config.agents.implementationAgent.systemPrompt,
      config.agents.implementationAgent.reasoningEffort,
      config.agents.implementationAgent.maxTokens,
      config.maxToolCallIterations,
    );
    implCoordUsage = addTokenUsage(implCoordUsage, coordResult.usage);
    implCoordCalls += coordResult.tasksCompleted;

    console.log(
      chalk.green(`✓ Implementation complete (${coordResult.tasksCompleted} tasks done)`),
    );

    // ── Start/restart dev server ────────────────────────────────────────────
    if (devServerHandle) {
      await devServerHandle.stop();
    }
    console.log(chalk.bold(`\n🌐 Starting dev server at ${appUrl}...`));
    try {
      devServerHandle = await startDevServer(
        config.outputDir,
        config.devServer.startCommand,
        config.devServer.port,
      );
      console.log(chalk.green(`✓ Dev server running at ${appUrl}`));
    } catch (err) {
      console.warn(chalk.yellow(`⚠ Could not start dev server: ${err}`));
    }

    // ── Step 3: Evaluator Agent ──────────────────────────────────────────────
    console.log(chalk.bold(`\n🔍 Step 3 (iteration ${iteration}): Evaluator Agent...`));
    const currentDesign = await Bun.file(config.designFile).text();

    const evalResult = await runEvaluatorAgent(
      config.agents.evaluatorAgent.model,
      appUrl,
      currentDesign,
      config.planFile,
      config.designFile,
      config.memoryFile,
      config.playwright.browser,
      config.playwright.headless,
      config.agents.evaluatorAgent.systemPrompt,
      config.agents.evaluatorAgent.reasoningEffort,
      config.agents.evaluatorAgent.maxTokens,
    );
    evaluatorUsage = addTokenUsage(evaluatorUsage, evalResult.usage);
    evaluatorCalls++;

    if (evalResult.decision === "PASS") {
      result = "SUCCESS";
      resultReason = evalResult.explanation;
      console.log(chalk.green(`✓ Evaluator: PASS — ${evalResult.explanation}`));
      break;
    }

    console.log(chalk.yellow(`⚠ Evaluator: NEEDS_WORK — ${evalResult.explanation}`));

    if (iteration >= config.maxEvaluatorIterations) {
      result = "FAILURE";
      resultReason = `Max iterations (${config.maxEvaluatorIterations}) reached. Last issue: ${evalResult.explanation}`;
      console.log(chalk.red(`✗ Max iterations reached. Pipeline terminating.`));
      break;
    }

    // ── Re-run Task Agent with updated design.md ─────────────────────────────
    console.log(chalk.bold(`\n📋 Re-running Task Agent with updated design.md...`));
    const updatedDesign = await Bun.file(config.designFile).text();
    const reTaskResult = await runTaskAgent(
      config.agents.taskAgent.model,
      updatedDesign,
      config.planFile,
      config.memoryFile,
      config.agents.taskAgent.systemPrompt,
      config.agents.taskAgent.reasoningEffort,
      config.agents.taskAgent.maxTokens,
    );
    taskAgentUsage = addTokenUsage(taskAgentUsage, reTaskResult.usage);
    taskAgentCalls++;
    console.log(chalk.green(`✓ New plan.md generated for iteration ${iteration + 1}`));
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────────
  if (devServerHandle) {
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
