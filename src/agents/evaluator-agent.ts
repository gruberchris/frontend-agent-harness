import { createLLMClient } from "../llm/create-client.ts";
import type { ProviderConfig } from "../llm/provider.ts";
import { addTokenUsage, emptyTokenUsage, type TokenUsage, type MessageContentPart } from "../llm/types.ts";
import type { LLMMessage, ToolDefinition } from "../llm/types.ts";
import { PlaywrightMcpServer } from "../mcp/playwright-mcp-server.ts";
import type { McpTool } from "../mcp/mcp-client.ts";

export class EvaluatorModelIncompatibleError extends Error {
  constructor(model: string) {
    super(
      `Evaluator model "${model}" is not compatible with Playwright MCP.\n` +
      `The model repeatedly used "[object Object]" as element refs even after format corrections.\n` +
      `Fix: change "evaluatorAgent.model" in config.json to a model that understands playwright-mcp's ARIA snapshot ref format (e.g. [ref=e5] → pass "e5").`
    );
    this.name = "EvaluatorModelIncompatibleError";
  }
}

export type EvaluatorDecision = "PASS" | "NEEDS_WORK";

export interface EvaluatorResult {
  decision: EvaluatorDecision;
  explanation: string;
  usage: TokenUsage;
}

function mcpToolToDefinition(tool: McpTool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  };
}

const DECISION_TOOLS: ToolDefinition[] = [
  {
    name: "decide_pass",
    description: "The application meets all design expectations. Pipeline will end successfully.",
    parameters: {
      type: "object",
      properties: {
        explanation: {
          type: "string",
          description: "Summary of what was verified and why it passes",
        },
      },
      required: ["explanation"],
    },
  },
  {
    name: "decide_needs_work",
    description: "The application has significant discrepancies from the design, OR the page is blank/broken/unloadable. Call this immediately if the page did not load. Otherwise, call after exploring the visible UI.",
    parameters: {
      type: "object",
      properties: {
        explanation: {
          type: "string",
          description: "Detailed description of discrepancies found",
        },
        corrections: {
          type: "string",
          description: "Specific corrections needed, written as additional design notes. These will be saved to memory.md as lessons learned for the next iteration.",
        },
      },
      required: ["explanation", "corrections"],
    },
  },
];

export async function runEvaluatorAgent(
  model: string,
  providerConfig: ProviderConfig,
  appUrl: string,
  designContent: string,
  planFile: string,
  designFile: string,
  memoryFile: string,
  outputDir: string,
  playwrightBrowser: string,
  playwrightHeadless: boolean,
  systemPrompt: string,
  reasoningEffort?: string,
  maxTokens?: number,
  devServerError?: string,
  llmTimeoutSecs?: number,
  maxToolCallIterations = 40,
  llmStreamTimeoutSecs?: number,
  loopThreshold = 5,
): Promise<EvaluatorResult> {
  const client = createLLMClient(providerConfig, model, reasoningEffort, maxTokens, llmTimeoutSecs, undefined, undefined, llmStreamTimeoutSecs);
  let usage = emptyTokenUsage();

  // Skip Playwright entirely when we know the dev server is down — no point navigating
  let mcpTools: McpTool[] = [];
  let playwright: PlaywrightMcpServer | null = null;
  if (!devServerError) {
    playwright = new PlaywrightMcpServer(playwrightBrowser, playwrightHeadless, outputDir);
    try {
      mcpTools = await playwright.start();
      console.log(`    🎭 Playwright MCP ready (${mcpTools.length} tools)`);
    } catch (err) {
      // If Playwright MCP can't start, do a text-only evaluation
      console.warn(`    ⚠️  Could not start Playwright MCP: ${err}. Doing text-only evaluation.`);
    }
  } else {
    console.warn(`    ⚠️  Dev server is down — skipping Playwright, running text-only evaluation.`);
  }

  const availableTools: ToolDefinition[] = [
    ...mcpTools.map(mcpToolToDefinition),
    ...DECISION_TOOLS,
  ];

  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: devServerError
        ? `The dev server FAILED TO START at ${appUrl}. Do NOT attempt to use Playwright — it will not work.\n\nDev server error:\n\`\`\`\n${devServerError}\n\`\`\`\n\nBased on this error and the design below, call decide_needs_work with specific corrections that will fix the problem (e.g. missing files, wrong build config, missing entry point).\n\nOriginal design document:\n---\n${designContent}\n---`
        : `Evaluate the web application running at: ${appUrl}

Original design document:
---
${designContent}
---

Evaluate ONLY what is visible and interactive in the browser using Playwright tools. Do not attempt to verify files on the filesystem, server configuration, Dockerfiles, CI/CD pipelines, or any non-browser requirement — those are outside your scope.

Use the available Playwright tools to navigate to the application, explore its features, take screenshots, and verify it matches the design. Then call decide_pass or decide_needs_work.`,
    },
  ];

  let decision: EvaluatorDecision = "NEEDS_WORK";
  let explanation = "";
  let corrections = "";
  let decided = false;

  // Loop detection: track the last N tool call signatures across all turns
  const recentCallSigs: string[] = [];
  const LOOP_WINDOW = 10;
  const LOOP_THRESHOLD = loopThreshold;

  // When a loop is detected, strip Playwright tools so the model MUST decide.
  let onlyDecisionTools = false;

  // Invalid-ref tracking. "[object Object]" appears when a model doesn't understand
  // playwright-mcp's ARIA snapshot ref format (e.g. [ref=e5] → pass "e5").
  // We give the model REF_FORMAT_GRACE_LIMIT helpful corrections before concluding
  // the page is truly blank (a model that sees real elements will self-correct;
  // a model facing a genuinely blank page will keep failing).
  let invalidRefCount = 0;
  const REF_FORMAT_GRACE_LIMIT = 3;
  // Counts successful element interactions (clicks, typing, etc.) — not observations.
  // Used to detect premature NEEDS_WORK decisions from models that can't use refs.
  const INTERACTION_TOOLS = new Set(["browser_click", "browser_type", "browser_fill_form", "browser_select_option", "browser_hover", "browser_drag"]);
  let successfulInteractions = 0;

  // Tool-calling loop
  for (let i = 0; i < maxToolCallIterations; i++) {
    const iterationsLeft = maxToolCallIterations - i - 1;

    // Warn the agent when it's running low so it wraps up and decides,
    // even if it hasn't stopped calling Playwright tools on its own.
    if (iterationsLeft === 5) {
      messages.push({
        role: "user",
        content: `⚠️ You have only ${iterationsLeft} steps remaining. Stop exploring and call decide_pass or decide_needs_work NOW with a full explanation and corrections. Do not make any more Playwright tool calls unless absolutely necessary.`,
      });
    }

    const toolsForThisTurn = onlyDecisionTools ? DECISION_TOOLS : availableTools;
    const response = await client.chat(messages, toolsForThisTurn);
    usage = addTokenUsage(usage, response.usage);

    messages.push({
      role: "assistant",
      content: response.content,
      toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
    });

    if (response.finishReason === "stop" || response.toolCalls.length === 0) {
      const msg = response.content?.trim();
      if (msg) console.log(`    💬 Evaluator narrated: "${msg.slice(0, 200)}"`);
      if (iterationsLeft > 0) {
        messages.push({
          role: "user",
          content: onlyDecisionTools
            ? `You responded with text but no tool calls. Call decide_pass or decide_needs_work immediately.`
            : `You responded with text but no tool calls. You have ${iterationsLeft} steps left. Call decide_pass or decide_needs_work immediately if you have finished evaluating. Otherwise use a Playwright tool to continue.`,
        });
        continue;
      }
      // Out of steps — treat as inconclusive
      explanation = response.content ?? "Evaluation inconclusive";
      break;
    }

    decided = false;
    const collectedImages: MessageContentPart[] = [];
    let loopDetectedThisTurn = false;

    for (const toolCall of response.toolCalls) {
      if (toolCall.name === "decide_pass") {
        decision = "PASS";
        explanation = String(toolCall.arguments["explanation"] ?? "");
        decided = true;
        messages.push({
          role: "tool",
          content: "Decision recorded: PASS",
          toolCallId: toolCall.id,
        });
      } else if (toolCall.name === "decide_needs_work") {
        // If the model tried invalid refs but never successfully interacted with
        // the app, its NEEDS_WORK decision is based on its own limitations rather
        // than actual app defects — treat it as a model compatibility failure.
        if (invalidRefCount > 0 && successfulInteractions === 0) {
          await playwright?.stop();
          throw new EvaluatorModelIncompatibleError(model);
        }
        decision = "NEEDS_WORK";
        explanation = String(toolCall.arguments["explanation"] ?? "");
        corrections = String(toolCall.arguments["corrections"] ?? "");
        decided = true;
        messages.push({
          role: "tool",
          content: "Decision recorded: NEEDS_WORK",
          toolCallId: toolCall.id,
        });
      } else {
        // Once a loop has been detected earlier in this same batch, silently
        // close out remaining calls — only the first warning is printed.
        if (loopDetectedThisTurn) {
          messages.push({
            role: "tool",
            content: "Error: repeated call blocked — call decide_pass or decide_needs_work.",
            toolCallId: toolCall.id,
          });
          continue;
        }

        // ── Loop detection ────────────────────────────────────────────────────
        // Detect [object Object] refs — this means the model doesn't understand
        // playwright-mcp's ARIA ref format. Give it REF_FORMAT_GRACE_LIMIT
        // clear corrections before escalating to blank-page mode.
        const isInvalidRef = toolCall.arguments["ref"] === "[object Object]";

        // Track call signature in rolling window (only for calls we'll execute)
        const callSig = `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`;
        recentCallSigs.push(callSig);
        if (recentCallSigs.length > LOOP_WINDOW) recentCallSigs.shift();
        const sigRepeatCount = recentCallSigs.filter(s => s === callSig).length;
        const isLooping = sigRepeatCount >= LOOP_THRESHOLD;

        if (isInvalidRef || isLooping) {
          if (isInvalidRef) {
            invalidRefCount++;
            if (invalidRefCount <= REF_FORMAT_GRACE_LIMIT) {
              // Within grace period: give model a clear explanation of ref format
              console.log(`    ⚠️  Evaluator: invalid ref "[object Object]" (attempt ${invalidRefCount}/${REF_FORMAT_GRACE_LIMIT}) — explaining format`);
              messages.push({
                role: "tool",
                content:
                  `Error: "[object Object]" is not a valid element ref.\n\n` +
                  `Element refs are short string identifiers shown in the ARIA snapshot as [ref=eN]. ` +
                  `For example, if the snapshot contains:\n` +
                  `  - heading "Password Generator" [level=1] [ref=e5]\n` +
                  `  - button "Generate" [ref=e8]\n` +
                  `then pass "e5" or "e8" as the ref value — just the identifier after "ref=".\n\n` +
                  `Call browser_snapshot to see the current page elements and their refs, then retry with a valid ref string.`,
                toolCallId: toolCall.id,
              });
            } else {
              // Grace limit exhausted — the model can't use playwright-mcp refs.
              // Stop Playwright and abort with a clear configuration error.
              await playwright?.stop();
              throw new EvaluatorModelIncompatibleError(model);
            }
          } else {
            const reason = `"${toolCall.name}" has been called with identical arguments ${sigRepeatCount} times — stuck in a loop`;
            console.log(`    ⚠️  Evaluator loop: ${reason}`);
            messages.push({
              role: "tool",
              content: `Error: ${reason}. Stop repeating this call. If the page is blank or broken, call decide_needs_work immediately.`,
              toolCallId: toolCall.id,
            });
          }
          loopDetectedThisTurn = true;
          continue;
        }
        // ─────────────────────────────────────────────────────────────────────

        console.log(`    🌐 ${toolCall.name}(${JSON.stringify(toolCall.arguments).slice(0, 80)})`);
        if (!playwright) {
          messages.push({
            role: "tool",
            content: "Error: Playwright is not available — dev server is down.",
            toolCallId: toolCall.id,
          });
          continue;
        }
        try {
          const result = await playwright.callTool(toolCall.name, toolCall.arguments);
          const textParts = result.content
            .filter((c) => c.type === "text")
            .map((c) => (c as { text: string }).text);
          const imageParts = result.content
            .filter((c) => c.type === "image")
            .map((c) => ({
              type: "image" as const,
              data: (c as { data: string }).data,
              mimeType: (c as { mimeType: string }).mimeType,
            }));

          // 1. Push the tool response (OpenAI requires a tool message for every tool call)
          messages.push({
            role: "tool",
            content: textParts.join("\n") || "Action completed",
            toolCallId: toolCall.id,
          });

          if (INTERACTION_TOOLS.has(toolCall.name)) {
            successfulInteractions++;
          }

          // 1a. After navigation, wait for JS frameworks (e.g. React 18 concurrent mode)
          // to finish mounting before the LLM takes a snapshot. React's createRoot().render()
          // schedules the commit phase asynchronously, so the load event fires before the
          // DOM is populated. A short wait ensures the accessibility tree has content.
          if (toolCall.name === "browser_navigate") {
            await playwright.callTool("browser_wait_for", { time: 1 });
          }

          // 2. Collect images for a final user message
          if (imageParts.length > 0) {
            collectedImages.push(...imageParts);
          }
        } catch (err) {
          messages.push({
            role: "tool",
            content: `Error: ${String(err)}`,
            toolCallId: toolCall.id,
          });
        }
      }
    }

    // 3. After all tool messages, push any collected images in a user message
    if (collectedImages.length > 0) {
      // Prune old images to save context
      for (const msg of messages) {
        if (Array.isArray(msg.content)) {
          for (let j = 0; j < msg.content.length; j++) {
            if (msg.content[j]!.type === "image") {
              msg.content[j] = { type: "text", text: "[Previous screenshot omitted for context efficiency]" };
            }
          }
        }
      }

      messages.push({
        role: "user",
        content: [
          { type: "text", text: "Screenshots from previous actions:" },
          ...collectedImages,
        ],
      });
    }

    // 4. If a loop was detected this turn, strip Playwright tools and demand a decision.
    if (loopDetectedThisTurn && !decided) {
      onlyDecisionTools = true;
      messages.push({
        role: "user",
        content: `⚠️ You are repeating identical tool calls — further Playwright calls have been blocked. You must now make your final decision based solely on what you have already observed.\n\nIf the app met the design requirements based on your observations, call decide_pass. If you observed genuine discrepancies (wrong UI, missing features, broken functionality), call decide_needs_work with specific corrections. Do not call decide_needs_work simply because you did not finish exploring — base your decision only on actual problems you saw.`,
      });
    }

    if (decided) break;
  }

  await playwright?.stop();

  // ── Forced decision pass ───────────────────────────────────────────────────
  // If the main loop ended without a valid decision (loop exhausted, model
  // narrated its decision as text instead of calling the tool, or required
  // fields were left empty), force the model to make a complete decision using
  // ONLY the decision tools. Playwright is already stopped — no more browsing.
  const hasValidDecision =
    (decision === "PASS" && !!explanation) ||
    (decision === "NEEDS_WORK" && !!explanation && !!corrections);

  if (!hasValidDecision) {
    const missingFields = [];
    if (!explanation) missingFields.push("explanation");
    if (decision === "NEEDS_WORK" && !corrections) missingFields.push("corrections (specific fixes for the implementation agent)");

    const forcedPrompt = decided
      ? `You called ${decision} but left the following required fields empty: ${missingFields.join(", ")}. ` +
        `Call decide_pass or decide_needs_work again — this time fill in every required field completely.`
      : `You ran out of steps without calling decide_pass or decide_needs_work as a tool call. ` +
        `You MUST make your final decision NOW. Call decide_pass if the app meets the design, ` +
        `or decide_needs_work with a complete explanation AND specific corrections the implementation agent must make. ` +
        `You cannot use any Playwright tools.`;

    messages.push({ role: "user", content: forcedPrompt });

    for (let attempt = 0; attempt < 5; attempt++) {
      const forced = await client.chat(messages, DECISION_TOOLS);
      usage = addTokenUsage(usage, forced.usage);

      messages.push({
        role: "assistant",
        content: forced.content,
        toolCalls: forced.toolCalls.length > 0 ? forced.toolCalls : undefined,
      });

      for (const tc of forced.toolCalls) {
        if (tc.name === "decide_pass") {
          const exp = String(tc.arguments["explanation"] ?? "");
          if (exp) { decision = "PASS"; explanation = exp; }
          messages.push({ role: "tool", content: "Decision recorded: PASS", toolCallId: tc.id });
        } else if (tc.name === "decide_needs_work") {
          const exp = String(tc.arguments["explanation"] ?? "");
          const cor = String(tc.arguments["corrections"] ?? "");
          decision = "NEEDS_WORK";
          if (exp) explanation = exp;
          if (cor) corrections = cor;
          messages.push({ role: "tool", content: "Decision recorded: NEEDS_WORK", toolCallId: tc.id });
        }
      }

      // Valid decision — done
      if (decision === "PASS" && explanation) break;
      if (decision === "NEEDS_WORK" && explanation && corrections) break;

      // Still missing fields — nudge specifically about what's missing
      const stillMissing = [];
      if (!explanation) stillMissing.push("explanation");
      if (decision === "NEEDS_WORK" && !corrections) stillMissing.push("corrections");
      messages.push({
        role: "user",
        content: `The ${stillMissing.join(" and ")} field(s) are still empty. ` +
          `Call decide_${decision === "PASS" ? "pass" : "needs_work"} again with ${stillMissing.join(" and ")} filled in completely.`,
      });
    }
  }

  // ── Memory update ──────────────────────────────────────────────────────────
  // If NEEDS_WORK, append corrections/explanation to memory.md as lessons learned.
  if (decision === "NEEDS_WORK") {
    // Last-resort fallback if forced pass still couldn't extract content
    if (!explanation) explanation = corrections || "Evaluator indicated the app needs work but provided no specific details.";
    if (!corrections) corrections = explanation;

    const timestamp = new Date().toISOString();
    const correctionSection = `\n\n---\n\n## Evaluator Findings (${timestamp})\n\n${corrections}\n`;

    const existingMemory = (await Bun.file(memoryFile).exists()) ? await Bun.file(memoryFile).text() : "";
    await Bun.write(memoryFile, existingMemory + correctionSection);
  }

  return { decision, explanation, usage };
}
