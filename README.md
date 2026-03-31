# frontend-agent-harness

An automated multi-agent pipeline that takes a `design.md` as input, builds a frontend application iteratively, evaluates it with Playwright, and self-corrects until the app matches the design — or a configurable iteration limit is reached.

---

## Architecture

```
design.md
    │
    ▼
┌─────────────┐
│  Task Agent │  Reads design.md → writes plan.md with numbered tasks
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
  Pipeline    Appends corrections → design.md
  ends ✅     Re-runs Task Agent → new plan.md
              Back to Implementation Coordinator
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

Your token needs access to the GitHub Copilot API (`api.githubcopilot.com`). A PAT with the `copilot` scope works.

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

All 46 tests should pass without a real API token (LLM calls are mocked).

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

### CLI flags

| Flag | Default | Description |
|------|---------|-------------|
| `--design <path>` | `./design.md` | Path to your design document |
| `--config <path>` | `./config.json` | Path to harness configuration |
| `--help` | — | Show usage help |

### Exit codes

- `0` — Pipeline ended with `SUCCESS` (evaluator approved the app)
- `1` — Pipeline ended with `FAILURE` (max iterations reached or fatal error)

---

## Writing a Good design.md

The **Task Agent** reads `design.md` to generate the implementation plan. The more detail you provide, the better the results.

Recommended sections:

```markdown
# My App Name

## Overview
Brief description of what the app does and who it's for.

## Tech Stack
Specify preferred stack (e.g., React + TypeScript + Tailwind CSS).
If omitted, the Task Agent will choose based on the description.

## Pages / Screens
Describe each screen or major view.

## Features
List the key features and interactions.

## Visual Style
Colors, fonts, layout preferences.

## Data Model
If relevant, describe the shape of data the UI displays.
```

---

## config.json Reference

```json
{
  "maxEvaluatorIterations": 3,
  "outputDir": "./output",
  "designFile": "./design.md",
  "planFile": "./plan.md",
  "devServer": {
    "port": 3000,
    "startCommand": "bun run dev"
  },
  "playwright": {
    "headless": true,
    "browser": "chromium"
  },
  "agents": {
    "taskAgent": {
      "model": "gpt-4o",
      "systemPrompt": "You are an expert software architect..."
    },
    "implementationCoordinator": {
      "model": "gpt-4.1",
      "systemPrompt": "You are an implementation coordinator..."
    },
    "implementationAgent": {
      "model": "gpt-4o",
      "systemPrompt": "You are a coding implementation agent..."
    },
    "evaluatorAgent": {
      "model": "gpt-4o",
      "systemPrompt": "You are an expert UX evaluator..."
    }
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxEvaluatorIterations` | number | `3` | Max times the evaluator can request fixes before pipeline fails |
| `outputDir` | string | `./output` | Where the generated app is written |
| `designFile` | string | `./design.md` | Path to the design input document |
| `planFile` | string | `./plan.md` | Path where the task plan is written |
| `devServer.port` | number | `3000` | Port the generated app's dev server listens on |
| `devServer.startCommand` | string | `bun run dev` | Command to start the app server (run inside `outputDir`) |
| `playwright.headless` | boolean | `true` | Run browser headlessly |
| `playwright.browser` | string | `chromium` | Browser: `chromium`, `firefox`, or `webkit` |
| `agents.*.model` | string | `gpt-4o` | Model to use for each agent |
| `agents.*.systemPrompt` | string | *(required)* | The full system prompt for the agent — **no built-in fallback** |
| `agents.*.reasoningEffort` | string | *(omit)* | Reasoning level for o-series models: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`. Omit for standard models (GPT-4o, etc.) |

> **Note:** `systemPrompt` is **required** for every agent. There are no hardcoded fallback prompts in the source code — all agent behaviour is controlled entirely through `config.json`. The defaults in the provided `config.json` are production-ready starting points; customise them freely.

> **Note:** `reasoningEffort` only takes effect on models that support extended thinking (e.g. `o3`, `o3-mini`, `o4-mini`). It is silently ignored by standard models. Example:
> ```json
> {
>   "agents": {
>     "implementationAgent": {
>       "model": "o3-mini",
>       "reasoningEffort": "high",
>       "systemPrompt": "..."
>     }
>   }
> }
> ```

---

## plan.md Format

The Task Agent generates `plan.md` using this exact format. The file begins with a **header block** declaring the tech stack and project conventions, followed by the numbered tasks.

```markdown
## Tech Stack
- **Framework**: React 18 + TypeScript
- **Bundler**: Vite
- **Styling**: Tailwind CSS v3
- **Package manager**: Bun
- **Dev server**: `bun run dev` (port 3000)
- **Testing**: Bun test

## Project Conventions
- **Entry point**: `src/main.tsx`
- **Components**: `src/components/ComponentName.tsx`

---

### Task 1: Setup project scaffold
**Status**: pending
**Description**: Initialize a React + TypeScript project in ./output/ with Vite...
**Acceptance Criteria**: App runs on localhost:3000 and shows root component
**Example Code**:
\`\`\`typescript
// bun create vite output --template react-ts
\`\`\`

---

### Task 2: Create header component
**Status**: pending
...
```

**Status values:** `pending` → `in_progress` → `completed`

The Implementation Coordinator always picks the first `pending` task. The header block is injected as project context into every Implementation Agent call so it understands the established tech stack and file naming conventions.

---

## Pipeline Details

### Task Agent
- Input: full `design.md` text
- Output: writes `plan.md` with all tasks as `pending`
- Model: configurable via `agents.taskAgent.model`

### Implementation Coordinator
- Reads `plan.md`, finds the next `pending` task
- Passes it to the Implementation Agent
- Loops until no `pending` tasks remain

### Implementation Agent
- Receives one task at a time
- Has access to these tools (executed against `./output/`):
  - `read_file` — read a file
  - `write_file` — write/create a file (creates parent dirs)
  - `list_directory` — list directory contents
  - `run_command` — run a shell command (`bun install`, etc.)
  - `mark_task_complete` — signals completion and updates `plan.md`
- Receives a **project context snapshot** before each task: the plan header (tech stack + conventions), a file tree of `./output/`, and contents of key files (`package.json`, `tsconfig.json`, `index.html`, `src/main.tsx`, etc.)
- **Must** run the build (e.g. `bunx tsc --noEmit` or `bun run build`) and all unit tests (`bun test`) after implementing — all errors and failures must be fixed before calling `mark_task_complete`
- Runs in a tool-calling loop until `mark_task_complete` is called

### Evaluator Agent
- The harness auto-starts a Bun dev server in `./output/` before evaluation
- Spawns a local `@playwright/mcp` subprocess for browser automation
- Uses browser tools (navigate, screenshot, click, etc.) to explore the app
- Compares the live UI against `design.md`
- Returns `PASS` or `NEEDS_WORK`
- On `NEEDS_WORK`: appends correction notes to `design.md`, then the pipeline re-runs the Task Agent and Implementation Coordinator loop

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

## Running Tests

```bash
bun test
```

Tests live in `src/__tests__/` and use `bun:test`. All LLM and Playwright MCP calls are mocked — no API key needed.

| Test file | What it covers |
|-----------|---------------|
| `plan-parser.test.ts` | Task parsing, status updates, edge cases |
| `copilot-client.test.ts` | Token usage math, type helpers |
| `config.test.ts` | Config loading, defaults, validation |
| `task-agent.test.ts` | plan.md generation from mocked LLM |
| `implementation-agent.test.ts` | Tool dispatch, `mark_task_complete` loop |
| `implementation-coordinator.test.ts` | Task iteration with real plan-parser |
| `evaluator-agent.test.ts` | PASS/NEEDS_WORK decisions, design.md edits |
| `reporting.test.ts` | Token aggregation, table rendering |
| `harness.test.ts` | Full pipeline: success, max-iterations, missing design |

---

## Project Structure

```
frontend-agent-harness/
├── index.ts                              # CLI entry point
├── config.json                           # Default harness configuration
├── .env.example                          # Template for required env vars
├── design.md                             # Your design input (you create this)
├── plan.md                               # Generated task plan (auto-created)
├── output/                               # Generated frontend app lives here
└── src/
    ├── config.ts                         # Config schema + loader
    ├── agents/
    │   ├── task-agent.ts                 # design.md → plan.md
    │   ├── implementation-coordinator.ts # Task loop orchestration
    │   ├── implementation-agent.ts       # Single-task tool-calling agent
    │   └── evaluator-agent.ts            # Playwright MCP evaluation
    ├── llm/
    │   ├── copilot-client.ts             # GitHub Copilot API (OpenAI-compatible)
    │   └── types.ts                      # TokenUsage, LLMMessage, ToolCall types
    ├── mcp/
    │   ├── mcp-client.ts                 # JSON-RPC 2.0 stdio client
    │   └── playwright-mcp-server.ts      # @playwright/mcp subprocess lifecycle
    ├── plan/
    │   ├── plan-parser.ts                # parse/update/append tasks in plan.md
    │   └── types.ts                      # PlanTask, TaskStatus types
    ├── pipeline/
    │   ├── harness.ts                    # Main pipeline orchestration
    │   └── reporting.ts                  # Token/timing terminal report
    ├── server/
    │   └── dev-server.ts                 # Spawn/kill Bun dev server in output/
    └── __tests__/                        # Unit tests (bun test)
```

---

## Troubleshooting

**`Error: GITHUB_TOKEN environment variable is required`**
Copy `.env.example` to `.env` and add your GitHub personal access token.

**`Could not start Playwright MCP`**
Install Playwright browsers: `bunx playwright install chromium`

**Port conflict on 3000**
Change `devServer.port` in `config.json` to an available port.

**Evaluator always returns NEEDS_WORK**
- Increase `maxEvaluatorIterations` in `config.json`
- Add more detail to `design.md` so the Task Agent generates better tasks
- Check `plan.md` to see if tasks are being completed correctly

**Generated app won't start**
The `devServer.startCommand` in `config.json` must match a script in the generated app's `package.json`. The Implementation Agent sets this up, but if the stack choice is unusual, you may need to adjust the command.

