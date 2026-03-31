# frontend-agent-harness

An automated multi-agent pipeline that takes a `design.md` as input, builds a frontend application iteratively, evaluates it with Playwright, and self-corrects until the app matches the design — or a configurable iteration limit is reached.

---

## Architecture

```
design.md + memory.md
    │
    ▼
┌─────────────┐
│  Task Agent │  Reads design + memory → writes plan.md with numbered tasks
└──────┬──────┘
       │ plan.md
       ▼
┌──────────────────────────────┐
│  Implementation Coordinator  │  Loops until no pending tasks remain
│  ┌─────────────────────────┐ │
│  │  Implementation Agent   │ │  Writes files to ./output/, runs commands
│  │  (file + shell tools)   │ │  Marks each task "completed" in plan.md
│  └─────────────────────────┘ │
└──────────────┬───────────────┘
               │
               ▼
        Dev server started
        (auto-starts Bun in ./output/)
               │
               ▼
┌──────────────────────┐
│   Evaluator Agent    │  Playwright MCP screenshots → compares to design.md
└──────────┬───────────┘
           │
     ┌─────┴─────┐
     │           │
   PASS        NEEDS_WORK
     │           │
  Pipeline    Appends findings → memory.md
  ends ✅     (Keeps design.md pristine)
              Re-runs Task Agent → updated plan.md
              (if maxEvaluatorIterations reached → ❌ FAILURE)
```

---

## Prerequisites

- [Bun](https://bun.sh) v1.1+
- A GitHub account with [Copilot subscription](https://github.com/features/copilot) (for the API token)
- Playwright browsers (auto-installed, see setup below)

---

## Local Development Setup

### 1. Install dependencies

```bash
bun install
```

### 2. Configure environment

Copy the example env file and add your GitHub token:

```bash
cp .env.example .env
```

Edit `.env`:
```
GITHUB_TOKEN=ghp_your_token_here
```

### 3. Configure the harness

Copy and edit `config.json` (already provided with defaults):

```bash
# Edit config.json to customize models, ports, iteration limits, etc.
```

### 4. Install Playwright browsers (for the evaluator)

```bash
bunx playwright install chromium
```

### 5. Verify setup

```bash
bun test
```

All 50 tests should pass without a real API token (LLM calls are mocked).

---

## Usage

### Basic usage

Create a `design.md` file describing your frontend app, then run:

```bash
bun run index.ts
```

### With custom paths

```bash
bun run index.ts --design ./my-app-design.md --config ./config.json
```

---

## Key Features & Optimizations

### 🛡️ Stability & Resilience
- **Robust Parsing**: Task status updates in `plan.md` use line-by-line parsing rather than fragile regex, ensuring the state is never corrupted.
- **Fail-Fast Polling**: The dev server health-check loop detects if the process crashes immediately (e.g., due to a syntax error) and fails fast instead of hanging.
- **Process Cleanup**: Global process management ensures all subprocesses (Vite, Playwright) are killed gracefully on `SIGINT` or crash.
- **Loop Detection**: The implementation agent automatically detects and breaks out of infinite tool-calling loops.

### ⚡ Efficiency & Token Savings
- **Screenshot Pruning**: The Evaluator Agent prunes older base64 screenshots from its history as it navigates, keeping the context window small and focused.
- **On-Demand Context**: The Implementation Agent no longer receives the full contents of all core files upfront. Instead, it receives the file tree and uses the `read_file` tool to fetch exactly what it needs.
- **Pristine Design**: `design.md` is never modified. Evaluator feedback is stored in `memory.md`, which the Task Agent uses to iteratively refine the implementation plan.

---

## plan.md Format

The Task Agent generates `plan.md` with a **header block** (tech stack + conventions) followed by numbered tasks.

```markdown
## Tech Stack
- **Framework**: React 18 + TypeScript
- **Bundler**: Vite
...

## Project Conventions
- **Entry point**: `src/main.tsx`

---

### Task 1: Setup project scaffold
**Status**: pending
**Description**: Initialize project...
**Acceptance Criteria**: App runs...
**Example Code**:
```

**Status values:** `pending` → `in_progress` → `completed`

---

## Pipeline Details

### Task Agent
- Input: `design.md` + `memory.md` + previous `plan.md`.
- Output: writes or updates `plan.md` with tasks.

### Implementation Agent
- Has access to: `read_file`, `write_file`, `replace_text`, `list_directory`, `run_command`, `mark_task_complete`.
- **Loop Limit**: If the agent hits the tool-call limit (default 30) without marking the task complete, the task is left as `in_progress` and reported as a failure, preventing incorrect "completed" states.

### Evaluator Agent
- Auto-starts a Bun dev server in `./output/`.
- spaws Playwright MCP to explore the live UI.
- On `NEEDS_WORK`: appends corrections to `memory.md`, triggering a re-planning cycle.

---

## Token Usage Report

At the end of every run, a usage report is printed:

```
══════════════════════════════════════════════════════════════════════
  Pipeline Report
══════════════════════════════════════════════════════════════════════
Step                            Prompt  Completion     Total   Calls
──────────────────────────────────────────────────────────────────────
Task Agent                      12,450       3,200    15,650       1
Implementation Agent (×8)       98,000      45,000   143,000       8
Evaluator Agent (×2)            24,000       8,000    32,000       2
──────────────────────────────────────────────────────────────────────
GRAND TOTAL                    134,450      56,200   190,650
══════════════════════════════════════════════════════════════════════

Iterations: 2 | Elapsed: 4m 32s | Result: SUCCESS — All design checks passed
```

---

## Project Structure

```
frontend-agent-harness/
├── index.ts                              # CLI entry point
├── config.json                           # Default harness configuration
├── design.md                             # Your design input (pristine)
├── memory.md                             # Persistent "lessons learned" & evaluator findings
├── plan.md                               # Generated task plan
├── output/                               # Generated frontend app lives here
└── src/
    ├── agents/                           # Task, Implementation, Evaluator logic
    ├── llm/                              # GitHub Copilot API client
    ├── mcp/                              # Playwright MCP lifecycle
    ├── plan/                             # Robust plan parser
    ├── pipeline/                         # Harness orchestration & reporting
    ├── server/                           # Dev server process management
    └── __tests__/                        # Unit tests (bun test)
```
