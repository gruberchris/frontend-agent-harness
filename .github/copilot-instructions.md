# Copilot Instructions

## Build, Test, and Run

```bash
bun install                          # install dependencies
bun test                             # run all tests (48 tests, no API key needed — all LLM/MCP calls are mocked)
bun test src/__tests__/config.test.ts  # run a single test file
bun test --testNamePattern "parses all tasks"  # run tests matching a name pattern
bunx tsc --noEmit                    # type-check without building
bun run index.ts                     # run the harness (requires GITHUB_TOKEN in .env)
bun run index.ts --design ./my-design.md --config ./config.json
```

Required environment variable: `GITHUB_TOKEN` — a GitHub PAT with Copilot access. Bun auto-loads `.env`.

## Architecture

This is a **multi-agent pipeline** that turns a `design.md` into a running frontend app, evaluates it with Playwright, and self-corrects until the app matches the design.

```
design.md → Task Agent → plan.md → Implementation Coordinator
                                        └─ Implementation Agent (×N, tool-calling loop)
                                               └─ writes files to ./output/, runs shell commands
                                   → Dev server (auto-started in ./output/)
                                   → Evaluator Agent (Playwright MCP)
                                         ├─ PASS → pipeline ends ✅
                                         └─ NEEDS_WORK → appends corrections to design.md
                                                          → re-runs Task Agent → loops
```

**Pipeline entry:** `src/pipeline/harness.ts` — orchestrates all agents, manages the iteration loop, builds the token usage report.

**Agents** (`src/agents/`):
- `task-agent.ts` — single LLM call, writes `plan.md` with a header block + numbered tasks
- `implementation-coordinator.ts` — loops over pending tasks, builds project context snapshot before each one, calls implementation agent
- `implementation-agent.ts` — tool-calling loop (up to 50 iterations); tools: `read_file`, `write_file`, `list_directory`, `run_command`, `mark_task_complete`; exits when `mark_task_complete` is called
- `evaluator-agent.ts` — tool-calling loop with Playwright MCP tools + `decide_pass` / `decide_needs_work` decision tools

**LLM layer** (`src/llm/`): `CopilotClient` wraps the OpenAI SDK pointed at `https://api.githubcopilot.com`. All agent functions accept `model`, `systemPrompt`, and optional `reasoningEffort` (`"low" | "medium" | "high"` etc.) which maps to the OpenAI `reasoning_effort` parameter for o-series models.

**MCP layer** (`src/mcp/`): `McpClient` is a minimal JSON-RPC 2.0 stdio client. `PlaywrightMcpServer` spawns `bunx playwright-mcp` as a subprocess and proxies tool calls through it.

**Config** (`src/config.ts` + `config.json`): Zod schema with deep-merge loading. Defaults are defined in a `DEFAULTS` constant (not Zod nested defaults — Zod v4 drops nested `.default()` values). Every agent requires `model` and `systemPrompt` in config; `reasoningEffort` is optional.

**plan.md format**: Starts with a `## Tech Stack` / `## Project Conventions` header block, then `### Task N:` sections. The header is injected as project context into every implementation agent call. `plan-parser.ts` uses line-by-line iteration (not regex split — Bun's JSC engine does not support lookahead in `split()`).

## Key Conventions

**`addTokenUsage` is a pure function** — it returns a new object and does not mutate. Always capture the return value:
```ts
// ✅ correct
let usage = emptyTokenUsage();
usage = addTokenUsage(usage, response.usage);

// ❌ wrong — silently discards the result
addTokenUsage(usage, response.usage);
```

**All agent prompts live in `config.json` only** — there are no hardcoded fallback prompts in source files. `systemPrompt` is required for every agent in config.

**Project context injection** — before each implementation task, the coordinator builds a snapshot: plan header + 2-level file tree of `./output/` (skipping `node_modules`/`.git`, max 60 entries) + contents of key files (`package.json`, `tsconfig.json`, `index.html`, `src/main.tsx`, etc.). This is prepended to the implementation agent's user message.

**Test mocking** — tests use `mock.module("../llm/copilot-client.ts", ...)` to replace `CopilotClient`. No real API calls are made. Mock module state is shared within a test file, so use `let capturedArg` at module scope and reassign before each test that needs to inspect call arguments.

**Config merging** — uses explicit `DEFAULTS` + spread merge before `HarnessConfigSchema.parse(merged)`. Do not rely on Zod `.default()` on nested objects — it does not work correctly in Zod v4.

**File I/O** — use `Bun.file(path).text()` / `Bun.write(path, content)` for file reads/writes. Use `Bun.file(path).exists()` for existence checks. Do not use `node:fs` for simple reads/writes.

**Bun APIs** — use `Bun.$\`command\`` instead of `execa`, `Bun.spawn` for subprocesses, `bun:sqlite` for SQLite, `Bun.serve()` instead of Express. See `CLAUDE.md` for the full list.
