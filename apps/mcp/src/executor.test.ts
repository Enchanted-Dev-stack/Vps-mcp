import { describe, expect, it } from "vitest";
import { executeCommand } from "./executor.js";

describe("executor safety limits", () => {
  it("terminates a hung process group at the configured timeout", async () => {
    const started = Date.now();
    const result = await executeCommand("sleep 10", { timeoutMs: 1000 });
    const elapsed = Date.now() - started;
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("terminated after 1000 ms");
    expect(elapsed).toBeGreaterThanOrEqual(850);
    expect(elapsed).toBeLessThan(4000);
  });

  it("caps combined command output and reports truncation", async () => {
    const result = await executeCommand("python3 -c \"print('x'*10000)\"", { maxOutputBytes: 2048 });
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(2048);
    expect(result.stderr).toContain("output truncated at 2048 bytes");
    expect(result.exitCode).toBe(0);
  });
});
