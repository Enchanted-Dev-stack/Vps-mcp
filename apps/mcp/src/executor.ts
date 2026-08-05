import { spawn } from "node:child_process";

export interface ExecuteResult { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; }
export interface ExecuteOptions {
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  onStdout?: (chunk: string) => Promise<void> | void;
  onStderr?: (chunk: string) => Promise<void> | void;
}

export async function executeCommand(command: string, options: ExecuteOptions = {}): Promise<ExecuteResult> {
  const timeoutMs = Math.min(Math.max(Math.floor(options.timeoutMs ?? 60_000), 1_000), 300_000);
  const maxOutputBytes = Math.min(Math.max(options.maxOutputBytes ?? 1_000_000, 1_024), 5_000_000);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let captured = 0;
  let timedOut = false;
  let eventQueue = Promise.resolve();

  return await new Promise<ExecuteResult>((resolve) => {
    let settled = false;
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd: options.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const capture = (target: Buffer[], raw: Buffer, callback?: (chunk: string) => Promise<void> | void) => {
      const remaining = maxOutputBytes - captured;
      if (remaining <= 0) return;
      const part = raw.subarray(0, remaining);
      captured += part.length;
      target.push(part);
      if (callback) {
        const text = part.toString("utf8");
        eventQueue = eventQueue.then(async () => { await callback(text); });
      }
    };

    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk, options.onStdout));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk, options.onStderr));

    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }, timeoutMs);

    child.on("error", async (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await eventQueue;
      resolve({ stdout: "", stderr: error.message, exitCode: null, timedOut: false });
    });

    child.on("close", async (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await eventQueue;
      let stderrText = Buffer.concat(stderr).toString("utf8");
      if (timedOut) stderrText += `\n[terminated after ${timeoutMs} ms]`;
      if (captured >= maxOutputBytes) stderrText += `\n[output truncated at ${maxOutputBytes} bytes]`;
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: stderrText,
        exitCode: timedOut ? 124 : exitCode,
        timedOut,
      });
    });
  });
}
