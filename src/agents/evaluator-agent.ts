import { CopilotClient } from "../llm/copilot-client.ts";
import { addTokenUsage, emptyTokenUsage, type TokenUsage } from "../llm/types.ts";
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
    description: "The application has significant discrepancies from the design. List what needs fixing.",
    parameters: {
      type: "object",
      properties: {
        explanation: {
          type: "string",
          description: "Detailed description of discrepancies found",
        },
        corrections: {
          type: "string",
          description: "Specific corrections needed as additional design notes (will be appended to design.md)",
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
  playwrightBrowser: string,
  playwrightHeadless: boolean,
  systemPrompt: string,
  reasoningEffort?: string,
): Promise<EvaluatorResult> {
  const client = new CopilotClient(model, reasoningEffort);
  let usage = emptyTokenUsage();
  const playwright = new PlaywrightMcpServer(playwrightBrowser, playwrightHeadless);

  let mcpTools: McpTool[] = [];

  try {
    mcpTools = await playwright.start();
  } catch (err) {
    // If Playwright MCP can't start, do a text-only evaluation
    console.warn(`Warning: Could not start Playwright MCP: ${err}. Doing text-only evaluation.`);
  }

  const availableTools: ToolDefinition[] = [
    ...mcpTools.map(mcpToolToDefinition),
    ...DECISION_TOOLS,
  ];

  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `Evaluate the web application running at: ${appUrl}

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
      // Agent stopped without making a decision — treat as needs work
      explanation = response.content ?? "Evaluation inconclusive";
      break;
    }

    let decided = false;
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
        let toolResult: string;
        try {
          const result = await playwright.callTool(toolCall.name, toolCall.arguments);
          toolResult = result.content
            .map((c) => (c.type === "text" ? c.text : `[image: ${c.mimeType}]`))
            .join("\n");
        } catch (err) {
          toolResult = `Error: ${String(err)}`;
        }
        messages.push({
          role: "tool",
          content: toolResult,
          toolCallId: toolCall.id,
        });
      }
    }

    if (decided) break;
  }

  await playwright.stop();

  // If NEEDS_WORK, append corrections to design.md
  if (decision === "NEEDS_WORK" && corrections) {
    const existingDesign = await Bun.file(designFile).text();
    const correctionSection = `\n\n---\n\n## Evaluator Corrections (iteration ${Date.now()})\n\n${corrections}\n`;
    await Bun.write(designFile, existingDesign + correctionSection);
  }

  return { decision, explanation, usage };
}
