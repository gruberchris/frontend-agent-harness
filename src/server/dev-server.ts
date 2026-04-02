import * as path from "node:path";
import * as fs from "node:fs/promises";

export interface DevServerHandle {
  url: string;
  stop: () => Promise<void>;
}

const HEALTH_CHECK_INTERVAL_MS = 500;
const HEALTH_CHECK_TIMEOUT_MS = 30_000;

export async function startDevServer(
  outputDir: string,
  startCommand: string,
  port: number,
): Promise<DevServerHandle> {
  const absCwd = path.resolve(outputDir);

  // Ensure the working directory exists — Bun.spawn reports a confusing ENOENT
  // against the *executable* name when the cwd is missing, masking the real cause.
  await fs.mkdir(absCwd, { recursive: true });

  // Use the absolute path to /bin/sh so PATH lookup is never needed for the
  // shell itself, then let the shell resolve the rest of the command (including
  // /opt/homebrew/bin/bun) using the inherited process.env.PATH.
  const proc = Bun.spawn(["/bin/sh", "-c", startCommand], {
    cwd: absCwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  const url = `http://localhost:${port}`;

  // Drain stderr into a buffer for error reporting — capped at 3 KB
  const stderrChunks: string[] = [];
  (async () => {
    try {
      const decoder = new TextDecoder();
      for await (const chunk of proc.stderr as AsyncIterable<Uint8Array>) {
        stderrChunks.push(decoder.decode(chunk));
        if (stderrChunks.join("").length > 3_000) break;
      }
    } catch { /* ignore */ }
  })();

  // Poll until the server is responsive or timeout
  const deadline = Date.now() + HEALTH_CHECK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // exitCode is non-null as soon as the process exits for any reason
    if (proc.exitCode !== null || proc.killed) {
      const stderr = stderrChunks.join("").slice(0, 2_000).trim();
      throw new Error(
        `Dev server process exited prematurely (exit code ${proc.exitCode ?? "killed"}).${stderr ? `\nStderr:\n${stderr}` : ""}`,
      );
    }

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status < 500) return {
        url,
        stop: async () => {
          proc.kill();
          await proc.exited;
        },
      };
    } catch {
      // not ready yet
    }
    await Bun.sleep(HEALTH_CHECK_INTERVAL_MS);
  }

  // Timed out — kill and report
  proc.kill();
  await proc.exited;
  const stderr = stderrChunks.join("").slice(0, 2_000).trim();
  throw new Error(
    `Dev server failed to start within ${HEALTH_CHECK_TIMEOUT_MS / 1000}s.${stderr ? `\nStderr:\n${stderr}` : ""}`,
  );
}
