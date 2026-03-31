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
  const [cmd, ...cmdArgs] = startCommand.split(" ");
  const proc = Bun.spawn([cmd!, ...cmdArgs], {
    cwd: outputDir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const url = `http://localhost:${port}`;

  // Poll until the server is responsive or timeout
  const deadline = Date.now() + HEALTH_CHECK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (proc.killed) {
      throw new Error("Dev server process exited prematurely before becoming responsive.");
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

  // If we reach here, we timed out. Kill it.
  proc.kill();
  await proc.exited;
  throw new Error(`Dev server failed to start within ${HEALTH_CHECK_TIMEOUT_MS}ms`);
}
