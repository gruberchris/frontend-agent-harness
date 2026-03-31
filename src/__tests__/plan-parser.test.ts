import { describe, test, expect, afterEach } from "bun:test";
import { parseTasks, parsePlanHeader } from "../plan/plan-parser.ts";
import * as fs from "node:fs/promises";

const trackedFiles: string[] = [];

afterEach(async () => {
  for (const f of trackedFiles) {
    await fs.rm(f, { force: true, recursive: true }).catch(() => {});
  }
  trackedFiles.length = 0;
});

const PLAN_HEADER = `## Tech Stack
- **Framework**: React 18 + TypeScript
- **Bundler**: Vite
- **Styling**: Tailwind CSS v3
- **Package manager**: Bun
- **Dev server**: \`bun run dev\` (port 3000)

## Project Conventions
- **Entry point**: \`src/main.tsx\`
- **Components**: \`src/components/ComponentName.tsx\` (PascalCase)

---`;

const SAMPLE_PLAN = `${PLAN_HEADER}

### Task 1: Setup project scaffold
**Status**: pending
**Description**: Initialize a React TypeScript project in ./output/
**Acceptance Criteria**: App runs on localhost:3000
**Example Code**:
\`\`\`typescript
import React from "react";
\`\`\`

---

### Task 2: Create header component
**Status**: completed
**Description**: Build a responsive header
**Acceptance Criteria**: Header shows logo and nav links
**Example Code**:
\`\`\`tsx
export const Header = () => <header>...</header>
\`\`\`

---

### Task 3: Add footer
**Status**: in_progress
**Description**: Create a footer component
**Acceptance Criteria**: Footer appears at bottom of page
**Example Code**:
\`\`\`tsx
export const Footer = () => <footer>...</footer>
\`\`\`
`;

describe("parseTasks", () => {
  test("parses all tasks from plan content", () => {
    const tasks = parseTasks(SAMPLE_PLAN);
    expect(tasks).toHaveLength(3);
  });

  test("parses task numbers correctly", () => {
    const tasks = parseTasks(SAMPLE_PLAN);
    expect(tasks[0]!.number).toBe(1);
    expect(tasks[1]!.number).toBe(2);
    expect(tasks[2]!.number).toBe(3);
  });

  test("parses task titles correctly", () => {
    const tasks = parseTasks(SAMPLE_PLAN);
    expect(tasks[0]!.title).toBe("Setup project scaffold");
    expect(tasks[1]!.title).toBe("Create header component");
  });

  test("parses task statuses correctly", () => {
    const tasks = parseTasks(SAMPLE_PLAN);
    expect(tasks[0]!.status).toBe("pending");
    expect(tasks[1]!.status).toBe("completed");
    expect(tasks[2]!.status).toBe("in_progress");
  });

  test("parses descriptions", () => {
    const tasks = parseTasks(SAMPLE_PLAN);
    expect(tasks[0]!.description).toContain("Initialize a React");
  });

  test("returns empty array for empty content", () => {
    expect(parseTasks("")).toHaveLength(0);
    expect(parseTasks("# Just a heading\n\nNo tasks here")).toHaveLength(0);
  });
});

describe("updateTaskStatus", () => {
  test("updates status in plan file", async () => {
    const tmpFile = `/tmp/plan-test-${Date.now()}.md`;
    trackedFiles.push(tmpFile);
    await Bun.write(tmpFile, SAMPLE_PLAN);

    const { updateTaskStatus } = await import("../plan/plan-parser.ts");
    await updateTaskStatus(tmpFile, 1, "completed");

    const updated = await Bun.file(tmpFile).text();
    const tasks = parseTasks(updated);
    expect(tasks[0]!.status).toBe("completed");
    // Other tasks unchanged
    expect(tasks[1]!.status).toBe("completed");
    expect(tasks[2]!.status).toBe("in_progress");
  });
});

describe("getNextPendingTask", () => {
  test("returns first pending task", async () => {
    const tmpFile = `/tmp/plan-test-${Date.now()}.md`;
    trackedFiles.push(tmpFile);
    await Bun.write(tmpFile, SAMPLE_PLAN);

    const { getNextPendingTask } = await import("../plan/plan-parser.ts");
    const task = await getNextPendingTask(tmpFile);
    expect(task).not.toBeNull();
    expect(task!.number).toBe(1);
    expect(task!.status).toBe("pending");
  });

  test("returns null when no pending tasks", async () => {
    const allComplete = SAMPLE_PLAN
      .replace(/\*\*Status\*\*: pending/g, "**Status**: completed")
      .replace(/\*\*Status\*\*: in_progress/g, "**Status**: completed");

    const tmpFile = `/tmp/plan-test-${Date.now()}.md`;
    await Bun.write(tmpFile, allComplete);

    const { getNextPendingTask } = await import("../plan/plan-parser.ts");
    const task = await getNextPendingTask(tmpFile);
    expect(task).toBeNull();
  });

  test("returns null for non-existent file", async () => {
    const { getNextPendingTask } = await import("../plan/plan-parser.ts");
    const task = await getNextPendingTask("/tmp/nonexistent-plan-xyz.md");
    expect(task).toBeNull();
  });
});

describe("parsePlanHeader", () => {
  test("extracts everything before the first task", () => {
    const header = parsePlanHeader(SAMPLE_PLAN);
    expect(header).toContain("## Tech Stack");
    expect(header).toContain("React 18 + TypeScript");
    expect(header).toContain("## Project Conventions");
    expect(header).not.toContain("### Task 1");
  });

  test("returns empty string for plan with no header", () => {
    const noHeader = `### Task 1: Setup\n**Status**: pending\n**Description**: init\n**Acceptance Criteria**: runs\n**Example Code**:\n\`\`\`ts\n//\n\`\`\`\n`;
    const header = parsePlanHeader(noHeader);
    expect(header).toBe("");
  });

  test("returns full content when no tasks present", () => {
    const headerOnly = "## Tech Stack\n- React\n\n## Conventions\n- PascalCase";
    const header = parsePlanHeader(headerOnly);
    expect(header).toBe(headerOnly.trim());
  });

  test("reads header from file", async () => {
    const tmpFile = `/tmp/plan-header-${Date.now()}.md`;
    trackedFiles.push(tmpFile);
    await Bun.write(tmpFile, SAMPLE_PLAN);

    const { readPlanHeader } = await import("../plan/plan-parser.ts");
    const header = await readPlanHeader(tmpFile);
    expect(header).toContain("## Tech Stack");
    expect(header).not.toContain("### Task");
  });

  test("returns empty string for non-existent plan file", async () => {
    const { readPlanHeader } = await import("../plan/plan-parser.ts");
    const header = await readPlanHeader("/tmp/nonexistent-plan-header-xyz.md");
    expect(header).toBe("");
  });
});
