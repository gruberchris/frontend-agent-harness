import { runHarness } from "./src/pipeline/harness.ts";
import { loadConfig } from "./src/config.ts";
import chalk from "chalk";

const HELP = `
${chalk.bold("Frontend Design Agent Harness")}

Usage:
  bun run index.ts [options]

Options:
  --design <path>   Path to design.md  (default: ./design.md)
  --config <path>   Path to config.json (default: ./config.json)
  --help            Show this help message

Environment Variables:
  GITHUB_TOKEN      GitHub OAuth token with Copilot access (optional if 'gh auth login' is used)
                    Note: classic PATs are NOT supported — use 'gh auth token' or an OAuth token

Example:
  bun run index.ts --design ./my-app-design.md --config ./config.json
`;

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
