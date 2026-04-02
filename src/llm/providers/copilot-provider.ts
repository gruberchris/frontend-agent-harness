import OpenAI from "openai";
import { OpenAICompatibleProvider } from "./base-provider.ts";

async function resolveToken(): Promise<string> {
  const envToken = process.env["GITHUB_TOKEN"];
  if (envToken) return envToken;

  try {
    const result = await Bun.$`gh auth token`.quiet();
    const token = result.stdout.toString().trim();
    if (token) return token;
  } catch {
    // gh not installed or not authenticated — fall through to error
  }

  throw new Error(
    "No GitHub token found. Set GITHUB_TOKEN in .env or run `gh auth login` to authenticate via the GitHub CLI.\n" +
    "Note: Personal Access Tokens (PATs) are not supported — the Copilot API requires an OAuth token.\n" +
    "Get one with: gh auth login  (then the harness will pick it up automatically)",
  );
}

export class CopilotProvider extends OpenAICompatibleProvider {
  protected async initClient(): Promise<void> {
    const token = await resolveToken();
    this.client = new OpenAI({
      apiKey: token,
      baseURL: "https://api.githubcopilot.com",
    });
  }
}
