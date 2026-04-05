import { createLLMClient } from "../llm/create-client.ts";
import type { ProviderConfig } from "../llm/provider.ts";
import { addTokenUsage, emptyTokenUsage, type TokenUsage, type MessageContentPart } from "../llm/types.ts";
import type { LLMMessage, ToolDefinition } from "../llm/types.ts";
import { PlaywrightMcpServer } from "../mcp/playwright-mcp-server.ts";
import type { McpTool } from "../mcp/mcp-client.ts";

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
  const LOOP_THRESHOLD = 3; // same sig this many times in window = loop

  // When a loop is detected, strip Playwright tools so the model MUST decide.
  let onlyDecisionTools = false;

  // Blank page detection: set when any tool call returns an invalid [object Object] ref.
  // Persists across outer loop iterations so we only act on it once.
  let invalidRefDetected = false;
  let invalidRefWarningLogged = false;

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
        // Execute Playwright MCP tool

        // ── Loop detection ────────────────────────────────────────────────────
        // Detect [object Object] refs (invalid — blank page or serialization bug)
        const isInvalidRef = toolCall.arguments["ref"] === "[object Object]";

        // Track call signature in rolling window
        const callSig = `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`;
        recentCallSigs.push(callSig);
        if (recentCallSigs.length > LOOP_WINDOW) recentCallSigs.shift();
        const sigRepeatCount = recentCallSigs.filter(s => s === callSig).length;
        const isLooping = sigRepeatCount >= LOOP_THRESHOLD;

        if (isInvalidRef || isLooping) {
          const reason = isInvalidRef
            ? `"[object Object]" is not a valid element ref — the page is likely blank or the snapshot returned no elements`
            : `"${toolCall.name}" has been called with identical arguments ${sigRepeatCount} times — stuck in a loop`;
          if (isInvalidRef) {
            if (!invalidRefWarningLogged) {
              console.log(`    ⚠️  Evaluator loop: ${reason}`);
              invalidRefWarningLogged = true;
            }
          } else {
            console.log(`    ⚠️  Evaluator loop: ${reason}`);
          }
          messages.push({
            role: "tool",
            content: `Error: ${reason}. Stop repeating this call. If the page is blank or broken, call decide_needs_work immediately.`,
            toolCallId: toolCall.id,
          });
          if (isInvalidRef) invalidRefDetected = true;
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

    // 4. If the page appeared blank (all snapshot refs were invalid), do one focused
    // LLM call with rich context so it can write the best possible NEEDS_WORK decision.
    if (invalidRefDetected && !decided) {
      console.log(`    ⚠️  Blank page detected — Playwright snapshot returned no valid DOM elements. Requesting NEEDS_WORK decision from LLM...`);
      onlyDecisionTools = true;
      messages.push({
        role: "user",
        content:
          `The application at ${appUrl} appears to have rendered a blank page. ` +
          `All Playwright element refs returned "[object Object]" (invalid), which means the page snapshot found no DOM elements at all.\n\n` +
          `Likely causes:\n` +
          `- The JavaScript framework (e.g. React) failed to mount to the DOM\n` +
          `- A JavaScript error or unhandled exception prevented rendering\n` +
          `- The HTML root element is missing or has the wrong id\n` +
          `- The build output is empty, malformed, or not being served correctly\n` +
          `- A missing dependency, failed import, or syntax error crashed the app\n\n` +
          `You no longer have access to Playwright tools. Based on the design document and these observations, ` +
          `call decide_needs_work with:\n` +
          `- explanation: describe what you observed (blank/unrendered page, no DOM elements)\n` +
          `- corrections: specific, actionable fixes the implementation agent must make`,
      });

      const blankPageResponse = await client.chat(messages, DECISION_TOOLS);
      usage = addTokenUsage(usage, blankPageResponse.usage);
      messages.push({
        role: "assistant",
        content: blankPageResponse.content,
        toolCalls: blankPageResponse.toolCalls.length > 0 ? blankPageResponse.toolCalls : undefined,
      });

      for (const tc of blankPageResponse.toolCalls) {
        if (tc.name === "decide_pass") {
          decision = "PASS";
          explanation = String(tc.arguments["explanation"] ?? "");
          decided = true;
          messages.push({ role: "tool", content: "Decision recorded: PASS", toolCallId: tc.id });
        } else if (tc.name === "decide_needs_work") {
          decision = "NEEDS_WORK";
          explanation = String(tc.arguments["explanation"] ?? "");
          corrections = String(tc.arguments["corrections"] ?? "");
          decided = true;
          messages.push({ role: "tool", content: "Decision recorded: NEEDS_WORK", toolCallId: tc.id });
        }
      }

      break; // exit outer loop regardless — blank page is unambiguous
    }

    // 5. If a generic loop was detected this turn (not blank-page), strip Playwright tools
    // and demand a decision on the next iteration.
    if (loopDetectedThisTurn && !decided) {
      onlyDecisionTools = true;
      messages.push({
        role: "user",
        content: `⚠️ You are stuck in a loop — repeated identical tool calls were detected and blocked. The page is likely blank or broken. You no longer have access to Playwright tools. Call decide_needs_work NOW with a description of what you observed and specific corrections for the implementation agent.`,
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
