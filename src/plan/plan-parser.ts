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
  return tasks.find((t) => t.status === "pending") ?? null;
}

export async function updateTaskStatus(
  planFile: string,
  taskNumber: number,
  newStatus: TaskStatus,
): Promise<void> {
  const file = Bun.file(planFile);
  let content = await file.text();

  // Find and replace the status line within the specific task block
  const taskHeaderPattern = new RegExp(
    `(###\\s+Task\\s+${taskNumber}:[\\s\\S]*?)\\*\\*Status\\*\\*:\\s*(pending|in_progress|completed)`,
    "m",
  );
  content = content.replace(taskHeaderPattern, `$1**Status**: ${newStatus}`);

  await Bun.write(planFile, content);
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
