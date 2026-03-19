import path from "path";
import { $ } from "zx";
import type { CliOptions, WorkConfig, WorktreeInfo } from "./types.js";
import { releaseWorktreeLock, tryAcquireWorktreeLock } from "./locking.js";
import * as log from "./log.js";
import type { GitBranchTarget } from "./git-target.js";
import { targetRef } from "./git-target.js";

interface WorktreeEntry {
  path: string;
  branchRef: string;
}

export async function listCliWorktrees(
  repoRoot: string,
  projectWorktreeDir: string,
  cli: string,
): Promise<WorktreeEntry[]> {
  const prefix = `${path.resolve(projectWorktreeDir)}${path.sep}${cli}-`;

  const result =
    await $`git -C ${repoRoot} worktree list --porcelain`.quiet().nothrow();
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return [];
  }

  const entries: WorktreeEntry[] = [];
  let currentPath = "";
  let currentBranch = "";

  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
      currentBranch = "";
    } else if (line.startsWith("branch ")) {
      currentBranch = line.split(" ")[1];
    } else if (line === "") {
      if (currentPath && currentPath.startsWith(prefix)) {
        entries.push({ path: currentPath, branchRef: currentBranch });
      }
      currentPath = "";
      currentBranch = "";
    }
  }

  if (currentPath && currentPath.startsWith(prefix)) {
    entries.push({ path: currentPath, branchRef: currentBranch });
  }

  return entries;
}

export async function selectWorktree(
  repoRoot: string,
  options: CliOptions,
  sessionTag: string,
  worktreeLockRoot: string,
  config: WorkConfig,
  branchTarget: GitBranchTarget,
  projectWorktreeDir: string,
): Promise<{ worktree: WorktreeInfo; lockDir: string }> {
  await $`git -C ${repoRoot} worktree prune`.quiet().nothrow();
  const desiredBranchName = `work/${sessionTag}`;

  if (options.reuseWorktree) {
    const entries = await listCliWorktrees(
      repoRoot,
      projectWorktreeDir,
      options.cli,
    );
    const sorted = [...entries].sort((a, b) => b.path.localeCompare(a.path));

    for (const entry of sorted) {
      const lockDir = tryAcquireWorktreeLock(
        worktreeLockRoot,
        entry.path,
      );
      if (!lockDir) {
        continue;
      }

      if (!options.noTodo) {
        const statusResult =
          await $`git -C ${entry.path} status --porcelain --untracked-files=all`
            .quiet()
            .nothrow();
        if (statusResult.exitCode !== 0 || statusResult.stdout.trim() !== "") {
          log.info(
            `Skipping reused worktree ${entry.path}: local changes or untracked files prevent switching to ${desiredBranchName}.`,
          );
          releaseWorktreeLock(lockDir);
          continue;
        }

        const checkoutResult =
          await $`git -C ${entry.path} checkout -B ${desiredBranchName} ${targetRef(branchTarget)}`
            .quiet()
            .nothrow();
        if (checkoutResult.exitCode !== 0) {
          log.info(
            `Skipping reused worktree ${entry.path}: failed to create fresh task branch ${desiredBranchName}.`,
          );
          releaseWorktreeLock(lockDir);
          continue;
        }

        return {
          worktree: {
            path: entry.path,
            branchName: desiredBranchName,
            reuseMode: "reused",
          },
          lockDir,
        };
      }

      const branchName = entry.branchRef
        ? entry.branchRef.replace(/^refs\/heads\//, "")
        : "";

      return {
        worktree: {
          path: entry.path,
          branchName,
          reuseMode: "reused",
        },
        lockDir,
      };
    }
  }

  // Create new worktree
  const worktreePath = path.join(projectWorktreeDir, sessionTag);
  const branchName = desiredBranchName;

  const addResult =
    await $`git -C ${repoRoot} worktree add -b ${branchName} ${worktreePath} ${targetRef(branchTarget)}`
      .quiet()
      .nothrow();
  if (addResult.exitCode !== 0) {
    throw new Error(`Failed to create worktree at ${worktreePath}`);
  }

  // Call project-specific post-creation hook
  if (config.onWorktreeCreated) {
    try {
      await config.onWorktreeCreated(repoRoot, worktreePath);
    } catch (err) {
      log.error(
        `onWorktreeCreated hook failed for ${worktreePath}`,
      );
      await $`git -C ${repoRoot} worktree remove --force ${worktreePath}`
        .quiet()
        .nothrow();
      await $`git -C ${repoRoot} branch -D ${branchName}`.quiet().nothrow();
      throw err;
    }
  }

  const lockDir = tryAcquireWorktreeLock(
    worktreeLockRoot,
    worktreePath,
  );
  if (!lockDir) {
    log.error(
      `Failed to acquire lock for new worktree ${worktreePath}`,
    );
    await $`git -C ${repoRoot} worktree remove --force ${worktreePath}`
      .quiet()
      .nothrow();
    await $`git -C ${repoRoot} branch -D ${branchName}`.quiet().nothrow();
    throw new Error(
      `Failed to acquire lock for new worktree ${worktreePath}`,
    );
  }

  return {
    worktree: {
      path: worktreePath,
      branchName,
      reuseMode: "new",
    },
    lockDir,
  };
}
