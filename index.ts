import { runHarness } from "./src/pipeline/harness.ts";
import { loadConfig, type HarnessConfig } from "./src/config.ts";
import chalk from "chalk";
import { existsSync } from "node:fs";

const HELP = `
${chalk.bold("Frontend Design Agent Harness")}

Usage:
  bun run index.ts [options]

Options:
  --design <path>   Path to design.md  (default: ./input/design.md)
  --config <path>   Path to config.json (default: ./config.json)
  --help            Show this help message

Environment Variables:
  GITHUB_TOKEN      GitHub OAuth token with Copilot access (optional if 'gh auth login' is used)
                    Note: classic PATs are NOT supported — use 'gh auth token' or an OAuth token

Example:
  bun run index.ts --design ./my-app-design.md --config ./config.json
`;

/** Paths to check per browser on macOS and Linux/Windows */
const BROWSER_PATHS: Record<string, string[]> = {
  chrome: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
  firefox: [
    "/Applications/Firefox.app/Contents/MacOS/firefox",
    "/usr/bin/firefox",
    "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
  ],
  msedge: [
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/microsoft-edge",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
  // webkit is bundled by playwright-mcp; no system binary to check
};

async function checkBrowserAvailable(config: HarnessConfig): Promise<void> {
  const { browser } = config.playwright;
  const paths = BROWSER_PATHS[browser];

  if (!paths) return; // webkit — rely on playwright-mcp's bundled binary

  const found = paths.some((p) => existsSync(p));
  if (found) return;

  // Final fallback: try `which`
  const cmd = browser === "chrome" ? "google-chrome" : browser === "msedge" ? "microsoft-edge" : browser;
  const whichFound = await Bun.$`which ${cmd}`.quiet().then(() => true).catch(() => false);
  if (whichFound) return;

  console.error(chalk.red(`\nError: Browser '${browser}' is not installed or could not be found.`));
  console.error("The evaluator agent requires the browser to be installed before the pipeline starts.");
  if (browser === "chrome") {
    console.error("  → Download Google Chrome: https://www.google.com/chrome/");
    console.error("  → Or switch to a different browser in config.json: firefox, webkit, msedge");
  } else if (browser === "firefox") {
    console.error("  → Download Firefox: https://www.mozilla.org/firefox/");
  } else if (browser === "msedge") {
    console.error("  → Download Microsoft Edge: https://www.microsoft.com/edge/");
  }
  process.exit(1);
}


function parseArgs(args: string[]): { design?: string; config?: string; help: boolean } {
  const result: { design?: string; config?: string; help: boolean } = { help: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") {
      result.help = true;
    } else if (args[i] === "--design" && args[i + 1]) {
      result.design = args[++i];
    } else if (args[i] === "--config" && args[i + 1]) {
      result.config = args[++i];
    }
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

  if (!process.env["GITHUB_TOKEN"]) {
    // No env token — the client will try `gh auth token` automatically.
    // Only warn; don't exit. If gh is also unavailable the error surfaces at first LLM call.
    const ghAvailable = await Bun.$`gh auth token`.quiet().then(() => true).catch(() => false);
    if (!ghAvailable) {
      console.error(chalk.red("Error: No GitHub token available."));
      console.error("Either:");
      console.error("  1. Set GITHUB_TOKEN in .env (must be a GitHub OAuth token, not a PAT)");
      console.error("  2. Run `gh auth login` to authenticate via the GitHub CLI");
      process.exit(1);
    }
    console.log(chalk.dim("No GITHUB_TOKEN in env — using `gh auth token` automatically."));
  }

  const configPath = args.config ?? "./config.json";
  const config = await loadConfig(configPath);

  // CLI flags override config file
  if (args.design) config.designFile = args.design;

  // Pre-flight: verify the browser is installed before spending tokens
  await checkBrowserAvailable(config);

  try {
    const report = await runHarness(config);
    process.exit(report.result === "SUCCESS" ? 0 : 1);
  } catch (err) {
    console.error(chalk.red(`\nFatal error: ${err}`));
    if (err instanceof Error) console.error(chalk.dim(err.stack ?? ""));
    process.exit(1);
  }
}

main();
