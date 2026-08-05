import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { WorkspaceManager } from "./index.js";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("WorkspaceManager", () => {
  it("creates isolated worktrees for concurrent chats without touching base", async () => {
    const root = await mkdtemp(join(tmpdir(), "vpsmcp-ws-"));
    const repo = join(root, "repo");
    execFileSync("mkdir", ["-p", repo]);
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.email", "tests@example.com");
    git(repo, "config", "user.name", "Tests");
    await writeFile(join(repo, "same.txt"), "BASE\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "base");

    const manager = new WorkspaceManager(join(root, "worktrees"));
    const a = await manager.ensureWorktree({ repoPath: repo, chatId: "cht_A", baseBranch: "main" });
    const b = await manager.ensureWorktree({ repoPath: repo, chatId: "cht_B", baseBranch: "main" });
    expect(a.path).not.toBe(b.path);
    await writeFile(join(a.path, "same.txt"), "AAA\n");
    await writeFile(join(b.path, "same.txt"), "BBB\n");
    expect(await readFile(join(repo, "same.txt"), "utf8")).toBe("BASE\n");
    expect(await readFile(join(a.path, "same.txt"), "utf8")).toBe("AAA\n");
    expect(await readFile(join(b.path, "same.txt"), "utf8")).toBe("BBB\n");
  });
});
