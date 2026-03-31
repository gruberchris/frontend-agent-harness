export type TaskStatus = "pending" | "in_progress" | "completed";

export interface PlanTask {
  number: number;
  title: string;
  status: TaskStatus;
  description: string;
  acceptanceCriteria: string;
  exampleCode: string;
  raw: string;
}
