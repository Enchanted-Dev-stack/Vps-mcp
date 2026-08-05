import { access, mkdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

export function isPathWithin(base: string, candidate: string): boolean {
  const rel = relative(resolve(base), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !resolve(rel).startsWith(sep));
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

  async status(worktreePath: string): Promise<{ short: string; diffStat: string }> {
    const short = await git(worktreePath, ["status", "--short"]);
    const diffStat = await git(worktreePath, ["diff", "--stat"]);
    return { short, diffStat };
  }
}
