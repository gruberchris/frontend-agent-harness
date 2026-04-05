import { describe, test, expect, afterEach } from "bun:test";
import { loadConfig } from "../config.ts";
import * as fs from "node:fs/promises";

const trackedFiles: string[] = [];

afterEach(async () => {
  for (const f of trackedFiles) {
    await fs.rm(f, { force: true, recursive: true }).catch(() => {});
  }
  trackedFiles.length = 0;
});

describe("loadConfig", () => {
  test("returns defaults when config file does not exist", async () => {
    const config = await loadConfig("/tmp/nonexistent-config-xyz.json");
    expect(config.maxEvaluatorIterations).toBe(3);
    expect(config.outputDir).toBe("./output");
    expect(config.appDir).toBe("./output/app");
    expect(config.designFile).toBe("./input/design.md");
    expect(config.planFile).toBe("./output/plan.md");
    expect(config.devServer.port).toBe(3000);
    expect(config.playwright.browser).toBe("chrome");
    expect(config.playwright.headless).toBe(true);
    expect(config.agents.taskAgent.model).toBe("gpt-4o");
    expect(config.agents.implementationAgent.model).toBe("gpt-4o");
    expect(config.agents.evaluatorAgent.model).toBe("gpt-4o");
  });

  test("merges provided config with defaults", async () => {
    const tmpFile = `/tmp/config-test-${Date.now()}.json`;
    trackedFiles.push(tmpFile);
    await Bun.write(
      tmpFile,
      JSON.stringify({
        maxEvaluatorIterations: 5,
        agents: {
          taskAgent: { model: "claude-3.5-sonnet" },
        },
      }),
    );

    const config = await loadConfig(tmpFile);
    expect(config.maxEvaluatorIterations).toBe(5);
    expect(config.agents.taskAgent.model).toBe("claude-3.5-sonnet");
    // Defaults still apply for unset fields
    expect(config.outputDir).toBe("./output");
    expect(config.devServer.port).toBe(3000);
  });

  test("throws on invalid config values", async () => {
    const tmpFile = `/tmp/config-test-${Date.now()}.json`;
    trackedFiles.push(tmpFile);
    await Bun.write(tmpFile, JSON.stringify({ maxEvaluatorIterations: -1 }));

    expect(async () => loadConfig(tmpFile)).toThrow();
  });

  test("accepts valid browser values", async () => {
    const tmpFile = `/tmp/config-test-${Date.now()}.json`;
    trackedFiles.push(tmpFile);
    for (const browser of ["chrome", "firefox", "webkit", "msedge"]) {
      await Bun.write(tmpFile, JSON.stringify({ playwright: { browser } }));
      const config = await loadConfig(tmpFile);
      expect(config.playwright.browser).toBe(browser as "chrome" | "firefox" | "webkit" | "msedge");
    }
  });

  test("has default systemPrompt for each agent", async () => {
    const config = await loadConfig("/tmp/nonexistent-config-xyz.json");
    expect(config.agents.taskAgent.systemPrompt).toBeDefined();
    expect(config.agents.taskAgent.systemPrompt).toContain("architect");
    expect(config.agents.implementationAgent.systemPrompt).toBeDefined();
    expect(config.agents.implementationAgent.systemPrompt).toContain("implementation");
    expect(config.agents.evaluatorAgent.systemPrompt).toBeDefined();
    expect(config.agents.evaluatorAgent.systemPrompt).toContain("QA");
  });

  test("merges custom systemPrompt from config file", async () => {
    const tmpFile = `/tmp/config-test-sp-${Date.now()}.json`;
    trackedFiles.push(tmpFile);
    const customPrompt = "You are a Vue specialist.";
    await Bun.write(
      tmpFile,
      JSON.stringify({
        agents: {
          implementationAgent: { model: "gpt-4o", systemPrompt: customPrompt },
        },
      }),
    );

    const config = await loadConfig(tmpFile);
    expect(config.agents.implementationAgent.systemPrompt).toBe(customPrompt);
    // Other agents keep their defaults
    expect(config.agents.taskAgent.systemPrompt).toBeDefined();
  });

  test("accepts reasoningEffort for an agent", async () => {
    const tmpFile = `/tmp/config-test-re-${Date.now()}.json`;
    trackedFiles.push(tmpFile);
    await Bun.write(
      tmpFile,
      JSON.stringify({
        agents: {
          implementationAgent: {
            model: "o3-mini",
            systemPrompt: "You are a coder.",
            reasoningEffort: "high",
          },
        },
      }),
    );

    const config = await loadConfig(tmpFile);
    expect(config.agents.implementationAgent.model).toBe("o3-mini");
    expect(config.agents.implementationAgent.reasoningEffort).toBe("high");
    // Other agents have no reasoningEffort set
    expect(config.agents.taskAgent.reasoningEffort).toBeUndefined();
  });

  test("rejects invalid reasoningEffort values", async () => {
    const tmpFile = `/tmp/config-test-re-bad-${Date.now()}.json`;
    trackedFiles.push(tmpFile);
    await Bun.write(
      tmpFile,
      JSON.stringify({
        agents: {
          taskAgent: {
            model: "gpt-4o",
            systemPrompt: "You are an architect.",
            reasoningEffort: "ultra",
          },
        },
      }),
    );

    expect(async () => loadConfig(tmpFile)).toThrow();
  });

  test("accepts valid remote baseUrl for ollama provider", async () => {
    const tmpFile = `/tmp/config-test-ollama-url-${Date.now()}.json`;
    trackedFiles.push(tmpFile);
    await Bun.write(tmpFile, JSON.stringify({ provider: { type: "ollama", baseUrl: "http://192.168.1.100:11434" } }));

    const config = await loadConfig(tmpFile);
    expect(config.provider).toEqual({ type: "ollama", baseUrl: "http://192.168.1.100:11434" });
  });

  test("accepts valid remote baseUrl for lm-studio provider", async () => {
    const tmpFile = `/tmp/config-test-lms-url-${Date.now()}.json`;
    trackedFiles.push(tmpFile);
    await Bun.write(tmpFile, JSON.stringify({ provider: { type: "lm-studio", baseUrl: "http://10.0.0.5:1234" } }));

    const config = await loadConfig(tmpFile);
    expect(config.provider).toEqual({ type: "lm-studio", baseUrl: "http://10.0.0.5:1234" });
  });

  test("rejects invalid baseUrl for ollama provider", async () => {
    const tmpFile = `/tmp/config-test-ollama-bad-url-${Date.now()}.json`;
    trackedFiles.push(tmpFile);
    await Bun.write(tmpFile, JSON.stringify({ provider: { type: "ollama", baseUrl: "not-a-url" } }));

    expect(async () => loadConfig(tmpFile)).toThrow();
  });

  test("rejects invalid baseUrl for lm-studio provider", async () => {
    const tmpFile = `/tmp/config-test-lms-bad-url-${Date.now()}.json`;
    trackedFiles.push(tmpFile);
    await Bun.write(tmpFile, JSON.stringify({ provider: { type: "lm-studio", baseUrl: "not-a-url" } }));

    expect(async () => loadConfig(tmpFile)).toThrow();
  });
});
