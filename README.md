# frontend-agent-harness

An automated multi-agent pipeline that takes a `design.md` as input, builds a frontend application iteratively, evaluates it with Playwright, and self-corrects until the app matches the design — or a configurable iteration limit is reached.

---

## Architecture

```
input/design.md + output/memory.md
    │
    ▼
┌─────────────┐
│  Task Agent │  Reads design + memory → writes output/plan.md with numbered tasks
└──────┬──────┘
       │ output/plan.md
       ▼
┌──────────────────────────────┐
│  Implementation Coordinator  │  Loops until no pending tasks remain
│  ┌─────────────────────────┐ │
│  │  Implementation Agent   │ │  Writes files to ./output/app/, runs commands
│  │  (file + shell tools)   │ │  Marks each task "completed" in plan.md
│  └─────────────────────────┘ │
└──────────────┬───────────────┘
               │
               ▼
        Dev server started
        (auto-starts Bun in ./output/app/)
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
  Pipeline    Appends findings → output/memory.md
  ends ✅     (Keeps design.md pristine)
              Re-runs Task Agent → updated plan.md
              (if maxEvaluatorIterations reached → ❌ FAILURE)
```

---

## Prerequisites

- [Bun](https://bun.sh) v1.1+
- An LLM provider (see [Providers](#providers) below)
- Playwright browsers (auto-installed, see setup below)

---

## Local Development Setup

### 1. Install dependencies

```bash
bun install
```

### 2. Configure environment

Copy the example env file and add your credentials for the provider you intend to use:

```bash
cp .env.example .env
```

Edit `.env`:
```
# GitHub Copilot (default provider)
GITHUB_TOKEN=ghp_your_token_here

# Azure OpenAI (if using the azure provider)
# AZURE_OPENAI_API_KEY=your_azure_key_here

# Ollama and LM Studio do not require credentials
```

### 3. Configure the harness

Copy and edit `config.json` (already provided with defaults):

```bash
# Edit config.json to customize the provider, models, ports, iteration limits, etc.
```

See [Providers](#providers) for how to select and configure a provider.

### 4. Install Playwright browsers (for the evaluator)

```bash
bunx playwright install chromium
```

### 5. Verify setup

```bash
bun test
```

All tests should pass without a real API token (LLM calls are mocked).

---

## Usage

### Basic usage

Create a `design.md` file in the `input/` folder describing your frontend app, then run:

```bash
bun run index.ts
```

### With custom paths

```bash
bun run index.ts --design ./my-app-design.md --config ./config.json
```

---

## Configuration Reference

All settings live in `config.json`. Every field is optional — omitting a field uses the default.

### Top-level fields

| Field | Type | Default | Description |
|---|---|---|---|
| `outputDir` | string | `"./output"` | Directory where `plan.md`, `memory.md`, and the generated app are written |
| `appDir` | string | `"./output/app"` | Sub-directory where the generated app files live (must be inside `outputDir`) |
| `designFile` | string | `"./input/design.md"` | Path to your design document (never modified by the harness) |
| `planFile` | string | `"./output/plan.md"` | Path to the generated implementation plan |
| `memoryFile` | string | `"./output/memory.md"` | Path to the evaluator's persistent lessons-learned log |
| `maxEvaluatorIterations` | integer ≥ 1 | `3` | Maximum number of evaluate → fix cycles before the pipeline stops with FAILURE |
| `maxToolCallIterations` | integer ≥ 1 | `20` | Maximum tool calls the implementation agent may make per task |
| `commandTimeoutSecs` | integer ≥ 10 | `120` | Timeout (seconds) for shell commands run by the implementation agent |
| `llmTimeoutSecs` | integer ≥ 10 | `300` | Timeout (seconds) to receive the first response bytes from the LLM (connection phase). Cleared once streaming begins. |
| `llmStreamTimeoutSecs` | integer ≥ 10 | `1800` | Total wall-clock timeout (seconds) for a complete LLM response including the full streaming generation. Increase for large local models that generate slowly. If unset, falls back to `llmTimeoutSecs`. |
| `projectContextChars` | integer ≥ 500 | *(derived)* | Max characters of project snapshot per task. Auto-derived from `implementationAgent.contextWindow`; set explicitly to override. |
| `historyTrimThreshold` | integer ≥ 4 | *(derived)* | Trim conversation history when message count exceeds this. Auto-derived from `implementationAgent.contextWindow`. |
| `historyTrimKeep` | integer ≥ 2 | *(derived)* | Messages to keep after trimming. Auto-derived from `implementationAgent.contextWindow`. |
| `maxTaskRetries` | integer ≥ 1 | `2` | How many times to retry a failed task before permanently aborting the pipeline. |
| `maxConsecutiveLoops` | integer ≥ 1 | `3` | Consecutive loop-detection hits before aborting the task early. When the model ignores loop warnings for this many iterations in a row, the agent stops immediately rather than burning more LLM calls. The task is marked failed and the coordinator retries it. |

### Startup resume behavior

On startup the harness checks whether `planFile` already exists and has content:

- **`planFile` exists** → skip the Task Agent, resume implementation from the first task not yet marked `completed`
- **`planFile` missing or empty** → clear the entire `outputDir` and start fresh (runs the Task Agent on `designFile`)

To force a fresh start, delete `output/plan.md` (or the path configured as `planFile`).

### `devServer`

| Field | Type | Default | Description |
|---|---|---|---|
| `devServer.port` | integer 1–65535 | `3000` | Port the dev server listens on; also used by the Evaluator Agent to navigate to the app |
| `devServer.startCommand` | string | `"bun run dev"` | Shell command run inside `appDir` to start the dev server |

### `playwright`

| Field | Type | Default | Description |
|---|---|---|---|
| `playwright.headless` | boolean | `true` | Run the browser in headless mode; set to `false` to watch the evaluator navigate the UI |
| `playwright.browser` | `"chrome"` \| `"firefox"` \| `"webkit"` \| `"msedge"` | `"chrome"` | Browser used by the Evaluator Agent |

### `agents`

Each of the four agents (`taskAgent`, `implementationCoordinator`, `implementationAgent`, `evaluatorAgent`) shares the same set of fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | string | yes | Model name/deployment to use for this agent |
| `systemPrompt` | string | yes | System prompt sent to the model |
| `reasoningEffort` | `"none"` \| `"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` | no | Reasoning effort passed to the model (o-series / thinking models only); ignored by providers that don't support it |
| `maxTokens` | integer ≥ 256 | no | Maximum completion tokens for this agent's responses. Auto-derived from `contextWindow` if not set. |
| `contextWindow` | integer ≥ 1024 | no | Model's context window size in tokens. When set, automatically derives `maxTokens` and (for `implementationAgent`) the three context-tuning params below. |
| `parallelToolCalls` | boolean | no | When `false`, sends `parallel_tool_calls: false` to the API so the model makes one tool call per response. Recommended for local models (Gemma, Qwen, etc.) that generate runaway parallel batches. |
| `frequencyPenalty` | number (-2.0 to 2.0) | no | Penalises repeated tokens within a single response. Use `0.3` with local models that spam identical tool calls (e.g. 40× `list_directory` in one response) before the harness can intervene. **Not recommended for cloud models** (GPT-4o, Claude, etc.) that don't exhibit this behaviour, and may cause API errors with o-series reasoning models. |

**Example — reasoning model with high effort:**

```json
{
  "agents": {
    "implementationAgent": {
      "model": "o3-mini",
      "systemPrompt": "You are a coding implementation agent...",
      "reasoningEffort": "high",
      "maxTokens": 32768
    }
  }
}
```

**Example — local model with anti-spam settings:**

```json
{
  "agents": {
    "implementationAgent": {
      "model": "gemma-4-26b-a4b-it",
      "contextWindow": 12288,
      "parallelToolCalls": false,
      "frequencyPenalty": 0.3
    }
  }
}
```

### Context window scaling

For models with small context windows (local models, smaller hosted models), set `contextWindow` on the `implementationAgent` and the harness will automatically tune the three parameters that control how much context the agent sees per task:

| Parameter | Where set | Formula | Purpose |
|---|---|---|---|
| `maxTokens` | per-agent | `contextWindow × 0.3` (capped at 16,384) | Max output tokens per LLM response |
| `projectContextChars` | top-level | `contextWindow × 0.8` (capped at 50,000) | Max characters of project snapshot injected before each task |
| `historyTrimThreshold` | top-level | `contextWindow ÷ 1,000` (clamped 8–60) | Trim conversation history when it exceeds this many messages |
| `historyTrimKeep` | top-level | `historyTrimThreshold ÷ 2` (min 4) | Number of recent messages to keep after trimming |

Quick reference by context window size:

| Context window | `maxTokens` | `projectContextChars` | `historyTrimThreshold` | `historyTrimKeep` |
|---|---|---|---|---|
| **8K** | 2,457 | 6,553 | 8 | 4 |
| **12K** | 3,686 | 9,830 | 12 | 6 |
| **32K** | 9,830 | 25,600 | 32 | 16 |
| **64K** | 16,384 *(capped)* | 50,000 *(capped)* | 60 *(capped)* | 30 |
| **128K+** | 16,384 *(capped)* | 50,000 *(capped)* | 60 *(capped)* | 30 |

You can override any derived value explicitly — explicit config values always win:

```json
{
  "agents": {
    "implementationAgent": {
      "model": "gemma-4-26b-a4b-it",
      "contextWindow": 12288
    }
  },
  "projectContextChars": 6000
}
```

If you don't set `contextWindow`, the harness uses conservative defaults (`historyTrimThreshold: 30`, `historyTrimKeep: 15`, `projectContextChars: 50,000`).

---

## Providers

The harness supports four LLM providers, configured globally via the `provider` block in `config.json`. All agents use the same provider.

### GitHub Copilot (default)

Requires a GitHub account with a [Copilot subscription](https://github.com/features/copilot).

```json
{ "provider": { "type": "copilot" } }
```

Set `GITHUB_TOKEN` in `.env`, or the harness falls back to `gh auth token`.

### Azure OpenAI

```json
{
  "provider": {
    "type": "azure",
    "endpoint": "https://your-resource.openai.azure.com",
    "apiVersion": "2024-06-01"
  }
}
```

Set `AZURE_OPENAI_API_KEY` in `.env`. The model name in each agent config must match your Azure deployment name.

### Ollama (local)

Runs models locally via [Ollama](https://ollama.com). No API key needed.

```json
{
  "provider": {
    "type": "ollama",
    "baseUrl": "http://localhost:11434"
  }
}
```

`baseUrl` is optional — defaults to `http://localhost:11434`. `reasoningEffort` is ignored for Ollama.

### LM Studio (local)

Runs models locally via [LM Studio](https://lmstudio.ai). No API key needed.

```json
{
  "provider": {
    "type": "lm-studio",
    "baseUrl": "http://localhost:1234"
  }
}
```

`baseUrl` is optional — defaults to `http://localhost:1234`. `reasoningEffort` is ignored for LM Studio.

**Recommended extra settings for local models** (Gemma, Qwen, Mistral, etc.) that tend to spam repeated tool calls within a single response:

```json
{
  "agents": {
    "implementationAgent": {
      "parallelToolCalls": false,
      "frequencyPenalty": 0.3
    }
  }
}
```

`parallelToolCalls: false` enforces one tool call per turn at the API level. `frequencyPenalty: 0.3` discourages the model from generating dozens of identical tool calls within a single response (a known issue with Gemma 4 and similar MoE models). Remove or omit `frequencyPenalty` if you switch to a cloud provider — it is unnecessary and may cause errors with o-series models.

---

## Key Features & Optimizations

### 🛡️ Stability & Resilience
- **Robust Parsing**: Task status updates in `plan.md` use line-by-line parsing rather than fragile regex, ensuring the state is never corrupted.
- **Dev Server Health Check**: The harness polls the dev server for up to 30 seconds after starting it. If the process never responds with HTTP 200 (e.g. due to a crash or a port conflict), the pipeline falls back to text-only evaluation and feeds the error back to the Task Agent for correction.
- **Process Cleanup**: Global process management ensures all subprocesses (Vite, Playwright) are killed gracefully on `SIGINT` or crash.
- **Loop Detection**: The implementation agent detects and breaks infinite tool-calling loops using two strategies: (1) per-call repeat count — fires after the same tool+args is called more than twice; (2) sliding-window batch pattern — catches A→B→A→B cycles. When a loop is detected, a `user`-role correction message is injected (stronger signal than a `tool` error) along with specific recovery instructions.
- **Within-Response Deduplication**: When a local model generates dozens of identical tool calls in a single response (before the harness can intervene), the harness collapses them to one execution and returns a cached result for the rest — preventing context flooding and wasted tokens.
- **Gitignore**: The implementation agent always creates a `.gitignore` in the generated app root (with `node_modules`, `dist`, etc.) but never runs `git init`.

### ⚡ Efficiency & Token Savings
- **Screenshot Pruning**: The Evaluator Agent prunes older base64 screenshots from its history as it navigates, keeping the context window small and focused.
- **On-Demand Context**: The Implementation Agent receives the file tree and uses `read_file` to fetch exactly what it needs, rather than receiving all file contents upfront.
- **Design Image Stripping**: Design images are only sent to the first task and tasks with UI/layout/style in their title. Resending large base64 images on every task wastes significant tokens.
- **Design Text Cap**: The design document is capped at 2,000 chars per task message — the tech stack and conventions are already captured in the plan header above.
- **Command Output Cap**: `run_command` stdout is capped to the last 2,000 chars (success messages appear last) and stderr to the first 1,500 chars (first errors are most actionable).
- **Pristine Design**: `design.md` is never modified. Evaluator feedback is stored in `output/memory.md`, which the Task Agent uses to iteratively refine the implementation plan.

---

## plan.md Format

The Task Agent generates `output/plan.md` with a **header block** (tech stack + conventions) followed by numbered tasks.

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
- Input: `input/design.md` + `output/memory.md` + previous `output/plan.md`.
- Output: writes or updates `output/plan.md` with tasks.

### Implementation Agent
- Has access to: `read_file`, `write_file`, `replace_text`, `undo_edit`, `glob`, `grep_search`, `view_code_symbols`, `read_url`, `list_directory`, `run_command`, `mark_task_complete`.
- **Loop Limit**: If the agent hits `maxToolCallIterations` (default 20, configurable) without marking the task complete, the task is left as `in_progress` and reported as a failure, preventing incorrect "completed" states.

### Evaluator Agent
- Auto-starts a Bun dev server in `./output/app/`.
- Spawns Playwright MCP to explore the live UI.
- On `NEEDS_WORK`: appends corrections to `output/memory.md`, triggering a re-planning cycle.

---

## Token Usage Report

At the end of every run, a usage report is printed:

```
════════════════════════════════════════════════════════════════════════════════════
  Pipeline Report
════════════════════════════════════════════════════════════════════════════════════
Step                                      Prompt    Completion         Total   Calls
────────────────────────────────────────────────────────────────────────────────────
Task Agent (×2)                           16,666        16,384        33,050       2
Implementation Agent (×15)             1,124,304        39,125     1,163,429      15
Evaluator Agent (×2)                     345,717         3,915       349,632       2
────────────────────────────────────────────────────────────────────────────────────
GRAND TOTAL                            1,486,687        59,424     1,546,111
════════════════════════════════════════════════════════════════════════════════════

Iterations: 2  |  Elapsed: 16m 44s  |  Result: SUCCESS
```

---

## Project Structure

```
frontend-agent-harness/
├── index.ts                              # CLI entry point
├── config.json                           # Default harness configuration
├── input/
│   └── design.md                         # Your design input (pristine, never modified)
├── output/
│   ├── plan.md                           # Generated task plan
│   ├── memory.md                         # Persistent "lessons learned" & evaluator findings
│   └── app/                              # Generated frontend app lives here
└── src/
    ├── agents/                           # Task, Implementation, Evaluator logic
    ├── llm/                              # LLM provider abstraction + Copilot, Azure, Ollama, LM Studio providers
    ├── mcp/                              # Playwright MCP lifecycle
    ├── plan/                             # Robust plan parser
    ├── pipeline/                         # Harness orchestration & reporting
    ├── server/                           # Dev server process management
    └── __tests__/                        # Unit tests (bun test)
```
