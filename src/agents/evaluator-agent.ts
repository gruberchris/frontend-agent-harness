import { CopilotClient } from "../llm/copilot-client.ts";
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
    description: "The application has significant discrepancies from the design. Call this ONLY after you have explored ALL tabs, states, and features. List what needs fixing.",
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
): Promise<EvaluatorResult> {
  const client = new CopilotClient(model, reasoningEffort, maxTokens);
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

  // Tool-calling loop
  for (let i = 0; i < 30; i++) {
    const response = await client.chat(messages, availableTools);
    usage = addTokenUsage(usage, response.usage);

    messages.push({
      role: "assistant",
      content: response.content,
      toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
    });

    if (response.finishReason === "stop" || response.toolCalls.length === 0) {
      const iterationsLeft = 30 - i - 1;
      const msg = response.content?.trim();
      if (msg) console.log(`    💬 Evaluator narrated: "${msg.slice(0, 200)}"`);
      if (iterationsLeft > 0) {
        // Nudge: don't give up, keep exploring
        messages.push({
          role: "user",
          content: `You responded with text but no tool calls. Do NOT call decide_needs_work just because you want to explore more — use Playwright to do it NOW. You have ${iterationsLeft} steps left.\n\nIf you have genuinely finished evaluating ALL tabs and features, call decide_pass or decide_needs_work immediately. Otherwise, use a Playwright tool to continue exploring.`,
        });
        continue;
      }
      // Out of steps — treat as inconclusive
      explanation = response.content ?? "Evaluation inconclusive";
      break;
    }

    let decided = false;
    const collectedImages: MessageContentPart[] = [];

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

    if (decided) break;
  }

  await playwright?.stop();

  // If NEEDS_WORK, append corrections to memory.md
  if (decision === "NEEDS_WORK" && corrections) {
    const timestamp = new Date().toISOString();
    const correctionSection = `\n\n---\n\n## Evaluator Findings (${timestamp})\n\n${corrections}\n`;
    
    // Update memory.md (The persistent "lessons learned")
    const existingMemory = (await Bun.file(memoryFile).exists()) ? await Bun.file(memoryFile).text() : "";
    await Bun.write(memoryFile, existingMemory + correctionSection);
  }

  return { decision, explanation, usage };
}
