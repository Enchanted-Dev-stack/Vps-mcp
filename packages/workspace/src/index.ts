import { access, mkdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

export function isPathWithin(base: string, candidate: string): boolean {
  const rel = relative(resolve(base), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export interface WorktreeResult {
  path: string;
  branch: string;
  created: boolean;
}

export class WorkspaceManager {
  constructor(readonly worktreeRoot: string) {}

  async validateRepository(repoPath: string): Promise<{ root: string; branch: string }> {
    const root = await realpath(repoPath);
    await access(root, constants.R_OK | constants.X_OK);
    const inside = await git(root, ["rev-parse", "--is-inside-work-tree"]);
    if (inside !== "true") throw new Error(`${root} is not a Git work tree`);
    const top = await git(root, ["rev-parse", "--show-toplevel"]);
    const branch = await git(root, ["branch", "--show-current"]);
    return { root: await realpath(top), branch: branch || "HEAD" };
  }

  async ensureWorktree(input: { repoPath: string; chatId: string; baseBranch: string }): Promise<WorktreeResult> {
    const repo = await this.validateRepository(input.repoPath);
    const safeChat = input.chatId.replace(/[^A-Za-z0-9._-]/g, "-");
    const branch = `agent/${safeChat}`;
    const target = join(this.worktreeRoot, safeChat);
    await mkdir(dirname(target), { recursive: true });

    try {
      const targetStat = await stat(target);
      if (targetStat.isDirectory()) {
        const targetTop = await git(target, ["rev-parse", "--show-toplevel"]);
        const targetBranch = await git(target, ["branch", "--show-current"]);
        if (resolve(targetTop) === resolve(target) && targetBranch === branch) {
          return { path: target, branch, created: false };
        }
        throw new Error(`Existing path ${target} is not the expected worktree`);
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }

    const branchExists = await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo.root })
      .then(() => true)
      .catch(() => false);

    if (branchExists) {
      await git(repo.root, ["worktree", "add", target, branch]);
    } else {
      await git(repo.root, ["worktree", "add", "-b", branch, target, input.baseBranch]);
    }
    return { path: target, branch, created: true };
  }

  async removeWorktree(input: { repoPath: string; worktreePath: string; branch?: string | null }): Promise<void> {
    const repo = await this.validateRepository(input.repoPath);
    const managedRoot = resolve(this.worktreeRoot);
    const target = resolve(input.worktreePath);
    if (target === managedRoot || !isPathWithin(managedRoot, target)) {
      throw new Error(`Refusing to remove path outside managed worktree root: ${target}`);
    }
    if (input.branch && !input.branch.startsWith("agent/")) {
      throw new Error(`Refusing to delete non-agent branch ${input.branch}`);
    }
    await execFileAsync("git", ["worktree", "remove", "--force", target], { cwd: repo.root }).catch(async (error: any) => {
      if (error?.stderr?.includes("is not a working tree")) {
        await git(repo.root, ["worktree", "prune"]);
        return;
      }
      throw error;
    });
    if (input.branch) {
      const exists = await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${input.branch}`], { cwd: repo.root })
        .then(() => true)
        .catch(() => false);
      if (exists) await git(repo.root, ["branch", "-D", input.branch]);
    }
  }

  async diff(worktreePath: string): Promise<{ short: string; diffStat: string; diff: string }> {
    const root = await realpath(worktreePath);
    const [short, diffStat, unstaged, staged] = await Promise.all([
      git(root, ["status", "--short"]),
      git(root, ["diff", "--stat", "HEAD"]),
      git(root, ["diff", "--no-ext-diff", "--unified=3"]),
      git(root, ["diff", "--cached", "--no-ext-diff", "--unified=3"]),
    ]);
    return { short, diffStat, diff: [staged, unstaged].filter(Boolean).join("\n") };
  }

  async status(worktreePath: string): Promise<{ short: string; diffStat: string }> {
    const short = await git(worktreePath, ["status", "--short"]);
    const diffStat = await git(worktreePath, ["diff", "--stat"]);
    return { short, diffStat };
  }
}
