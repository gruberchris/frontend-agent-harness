import chalk from "chalk";
import type { TokenUsage } from "../llm/types.ts";

export interface AgentStepStats {
  name: string;
  usage: TokenUsage;
  callCount: number;
}

export interface PipelineReport {
  steps: AgentStepStats[];
  totalIterations: number;
  elapsedMs: number;
  result: "SUCCESS" | "FAILURE";
  resultReason?: string;
}

export function printReport(report: PipelineReport): void {
  const grandTotal: TokenUsage = report.steps.reduce(
    (acc, s) => ({
      promptTokens: acc.promptTokens + s.usage.promptTokens,
      completionTokens: acc.completionTokens + s.usage.completionTokens,
      totalTokens: acc.totalTokens + s.usage.totalTokens,
    }),
    { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  );

  const elapsed = formatElapsed(report.elapsedMs);

  console.log("\n" + chalk.bold("═".repeat(84)));
  console.log(chalk.bold("  Pipeline Report"));
  console.log(chalk.bold("═".repeat(84)));

  const COL_NAME = 34;
  const COL_NUM = 14;

  const header = [
    padEnd("Step", COL_NAME),
    padStart("Prompt", COL_NUM),
    padStart("Completion", COL_NUM),
    padStart("Total", COL_NUM),
    padStart("Requests", 10),
  ].join("");
  console.log(chalk.dim(header));
  console.log(chalk.dim("─".repeat(84)));

  for (const step of report.steps) {
    const label = step.callCount > 1 ? `${step.name} (×${step.callCount})` : step.name;
    const row = [
      padEnd(label, COL_NAME),
      padStart(step.usage.promptTokens.toLocaleString(), COL_NUM),
      padStart(step.usage.completionTokens.toLocaleString(), COL_NUM),
      padStart(step.usage.totalTokens.toLocaleString(), COL_NUM),
      padStart(String(step.callCount), 10),
    ].join("");
    console.log(row);
  }

  const grandTotalRequests = report.steps.reduce((acc, s) => acc + s.callCount, 0);

  console.log(chalk.dim("─".repeat(84)));
  const totalRow = [
    padEnd(chalk.bold("GRAND TOTAL"), COL_NAME),
    padStart(chalk.bold(grandTotal.promptTokens.toLocaleString()), COL_NUM),
    padStart(chalk.bold(grandTotal.completionTokens.toLocaleString()), COL_NUM),
    padStart(chalk.bold(grandTotal.totalTokens.toLocaleString()), COL_NUM),
    padStart(chalk.bold(String(grandTotalRequests)), 10),
  ].join("");
  console.log(totalRow);
  console.log(chalk.bold("═".repeat(84)));

  const resultColor = report.result === "SUCCESS" ? chalk.green : chalk.red;
  console.log(
    `\nIterations: ${chalk.cyan(report.totalIterations)}  |  ` +
    `Elapsed: ${chalk.cyan(elapsed)}  |  ` +
    `Result: ${resultColor(chalk.bold(report.result))}`,
  );
  if (report.resultReason) {
    console.log();
    console.log(formatResultReason(report.resultReason));
  }
  console.log();
  console.log();
}

function padEnd(s: string, len: number): string {
  // Strip ANSI escape codes for length calculation
  const plain = s.replace(/\u001B\[[0-9;]*m/g, "");
  const pad = Math.max(0, len - plain.length);
  return s + " ".repeat(pad);
}

function padStart(s: string, len: number): string {
  const plain = s.replace(/\u001B\[[0-9;]*m/g, "");
  const pad = Math.max(0, len - plain.length);
  return " ".repeat(pad) + s;
}

function formatResultReason(reason: string): string {
  // Split on numbered list items like "1)" "2)" etc. and put each on its own line
  const parts = reason.split(/(?=\s*\d+\))/);
  if (parts.length <= 1) return `  ${reason}`;
  return parts
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => `  ${p}`)
    .join("\n");
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
