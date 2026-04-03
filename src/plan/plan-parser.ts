import type { PlanTask, TaskStatus } from "./types.ts";

export function parsePlanHeader(content: string): string {
  const lines = content.split("\n");
  const taskLineIndex = lines.findIndex((line) => /^###\s+Task\s+\d+:/.test(line));
  if (taskLineIndex === -1) return content.trim();
  return lines.slice(0, taskLineIndex).join("\n").trim();
}

export async function readPlanHeader(planFile: string): Promise<string> {
  const file = Bun.file(planFile);
  if (!(await file.exists())) return "";
  const content = await file.text();
  return parsePlanHeader(content);
}

const TASK_HEADER_RE = /^###\s+Task\s+(\d+):\s+(.+)$/m;
const STATUS_RE = /^\*\*Status\*\*:\s*(pending|in_progress|completed)\s*$/m;
const DESCRIPTION_RE = /^\*\*Description\*\*:\s*([\s\S]*?)(?=\*\*Acceptance Criteria\*\*|\*\*Example Code\*\*|^---|\Z)/m;
const ACCEPTANCE_RE = /^\*\*Acceptance Criteria\*\*:\s*([\s\S]*?)(?=\*\*Example Code\*\*|^---|\Z)/m;
const EXAMPLE_CODE_RE = /^\*\*Example Code\*\*:\s*([\s\S]*?)(?=^---|\Z)/m;

function splitTasks(content: string): string[] {
  const chunks: string[] = [];
  const lines = content.split("\n");
  let chunkLines: string[] = [];
  let inTask = false;

  for (const line of lines) {
    if (/^###\s+Task\s+\d+:/.test(line)) {
      if (inTask) chunks.push(chunkLines.join("\n"));
      chunkLines = [line];
      inTask = true;
    } else if (inTask) {
      chunkLines.push(line);
    }
  }

  if (inTask && chunkLines.length > 0) chunks.push(chunkLines.join("\n"));
  return chunks;
}

function parseOneTask(chunk: string): PlanTask | null {
  const headerMatch = TASK_HEADER_RE.exec(chunk);
  if (!headerMatch) return null;

  const number = parseInt(headerMatch[1] ?? "0", 10);
  const title = (headerMatch[2] ?? "").trim();

  const statusMatch = STATUS_RE.exec(chunk);
  const status: TaskStatus = (statusMatch?.[1] as TaskStatus) ?? "pending";

  const descMatch = DESCRIPTION_RE.exec(chunk);
  const description = (descMatch?.[1] ?? "").trim();

  const acceptanceMatch = ACCEPTANCE_RE.exec(chunk);
  const acceptanceCriteria = (acceptanceMatch?.[1] ?? "").trim();

  const exampleMatch = EXAMPLE_CODE_RE.exec(chunk);
  const exampleCode = (exampleMatch?.[1] ?? "").trim();

  return { number, title, status, description, acceptanceCriteria, exampleCode, raw: chunk };
}

export function parseTasks(content: string): PlanTask[] {
  const chunks = splitTasks(content);
  return chunks.flatMap((c) => {
    const task = parseOneTask(c);
    return task ? [task] : [];
  });
}

export async function readTasks(planFile: string): Promise<PlanTask[]> {
  const file = Bun.file(planFile);
  if (!(await file.exists())) return [];
  const content = await file.text();
  return parseTasks(content);
}

export async function getNextPendingTask(planFile: string): Promise<PlanTask | null> {
  const tasks = await readTasks(planFile);
  // Treat in_progress as resumable — if a prior run was interrupted mid-task, pick it up again.
  return tasks.find((t) => t.status === "pending" || t.status === "in_progress") ?? null;
}

export async function updateTaskStatus(
  planFile: string,
  taskNumber: number,
  newStatus: TaskStatus,
): Promise<void> {
  const file = Bun.file(planFile);
  const content = await file.text();
  const lines = content.split("\n");

  let inTargetTask = false;
  let updated = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if we reached the target task header
    const taskHeaderMatch = line!.match(/^###\s+Task\s+(\d+):/);
    if (taskHeaderMatch) {
      const currentTaskNumber = parseInt(taskHeaderMatch[1]!, 10);
      inTargetTask = currentTaskNumber === taskNumber;
      continue;
    }

    // If we are in the target task, look for the Status line
    if (inTargetTask && line!.match(/^\*\*Status\*\*:/)) {
      lines[i] = `**Status**: ${newStatus}`;
      updated = true;
      break; // Done updating
    }
  }

  if (!updated) {
    // Status line may be missing (e.g. truncated plan) — insert it after the task header
    for (let i = 0; i < lines.length; i++) {
      const taskHeaderMatch = lines[i]!.match(/^###\s+Task\s+(\d+):/);
      if (taskHeaderMatch && parseInt(taskHeaderMatch[1]!, 10) === taskNumber) {
        lines.splice(i + 1, 0, `**Status**: ${newStatus}`);
        updated = true;
        break;
      }
    }
  }

  if (!updated) {
    throw new Error(`Failed to update status for Task ${taskNumber}. Task or Status line not found.`);
  }

  await Bun.write(planFile, lines.join("\n"));
}

export async function appendTasks(planFile: string, tasksMarkdown: string): Promise<void> {
  const file = Bun.file(planFile);
  const existing = (await file.exists()) ? await file.text() : "";
  const separator = existing.trimEnd().length > 0 ? "\n\n---\n\n" : "";
  await Bun.write(planFile, existing.trimEnd() + separator + tasksMarkdown.trim() + "\n");
}

export function formatTaskForAgent(task: PlanTask): string {
  return [
    `### Task ${task.number}: ${task.title}`,
    `**Status**: ${task.status}`,
    `**Description**: ${task.description}`,
    task.acceptanceCriteria ? `**Acceptance Criteria**: ${task.acceptanceCriteria}` : "",
    task.exampleCode ? `**Example Code**:\n${task.exampleCode}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
