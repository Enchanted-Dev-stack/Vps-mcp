import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { WorkspaceManager, isPathWithin } from "./index.js";

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

it("removes only managed chat worktrees and their agent branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "vpsmcp-clean-"));
  const repo = join(root, "repo");
  execFileSync("mkdir", ["-p", repo]);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "tests@example.com");
  git(repo, "config", "user.name", "Tests");
  await writeFile(join(repo, "same.txt"), "BASE\n");
  git(repo, "add", "."); git(repo, "commit", "-m", "base");
  const manager = new WorkspaceManager(join(root, "worktrees"));
  const wt = await manager.ensureWorktree({ repoPath: repo, chatId: "cht_cleanup", baseBranch: "main" });
  expect(git(repo, "branch", "--list", wt.branch)).toContain(wt.branch);
  await manager.removeWorktree({ repoPath: repo, worktreePath: wt.path, branch: wt.branch });
  expect(git(repo, "branch", "--list", wt.branch)).toBe("");
  await expect(readFile(join(wt.path, "same.txt"), "utf8")).rejects.toThrow();
  await expect(manager.removeWorktree({ repoPath: repo, worktreePath: "/tmp/not-managed", branch: "agent/nope" })).rejects.toThrow(/managed worktree root/);
});


it("recognizes nested paths but rejects sibling escapes", () => {
  expect(isPathWithin("/tmp/base", "/tmp/base/sub/dir")).toBe(true);
  expect(isPathWithin("/tmp/base", "/tmp/base-other/file")).toBe(false);
  expect(isPathWithin("/tmp/base", "/tmp/base/../outside")).toBe(false);
});


it("returns status and textual diff for a managed worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "vpsmcp-diff-"));
  const repo = join(root, "repo");
  execFileSync("mkdir", ["-p", repo]);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "tests@example.com"); git(repo, "config", "user.name", "Tests");
  await writeFile(join(repo, "same.txt"), "BEFORE\n"); git(repo, "add", "."); git(repo, "commit", "-m", "base");
  const manager = new WorkspaceManager(join(root, "worktrees"));
  const wt = await manager.ensureWorktree({ repoPath: repo, chatId: "cht_diff", baseBranch: "main" });
  await writeFile(join(wt.path, "same.txt"), "AFTER\n");
  const result = await manager.diff(wt.path);
  expect(result.short).toContain("M same.txt");
  expect(result.diffStat).toContain("same.txt");
  expect(result.diff).toContain("-BEFORE"); expect(result.diff).toContain("+AFTER");
});

describe("workspace folder semantics", () => {
  it("accepts a normal non-Git directory as a workspace root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "workspace-root-"));
    const root = join(parent, "project");
    await mkdir(root);
    await writeFile(join(root, "notes.txt"), "hello\n");
    const manager = new WorkspaceManager(join(parent, "worktrees"));
    const validated = await manager.validateWorkspaceRoot(root);
    expect(validated.root).toBe(await realpath(root));
    expect(validated.isGitRepository).toBe(false);
    await rm(parent, { recursive: true, force: true });
  });
});
