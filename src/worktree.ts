import { realpathSync } from "fs";
import path from "path";
import type { CliOptions, WorkConfig, WorktreeInfo } from "./types.js";
import { runGit } from "./git-cli.js";
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
  const prefixes = buildWorktreePrefixes(projectWorktreeDir, cli);
  const result = await runGit(["-C", repoRoot, "worktree", "list", "--porcelain"]);
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
      if (currentPath && worktreePathMatchesPrefixes(currentPath, prefixes)) {
        entries.push({ path: currentPath, branchRef: currentBranch });
      }
      currentPath = "";
      currentBranch = "";
    }
  }

  if (currentPath && worktreePathMatchesPrefixes(currentPath, prefixes)) {
    entries.push({ path: currentPath, branchRef: currentBranch });
  }

  return entries;
}

function buildWorktreePrefixes(projectWorktreeDir: string, cli: string): string[] {
  const variants = new Set<string>();
  const resolved = path.resolve(projectWorktreeDir);
  variants.add(resolved);

  try {
    variants.add(realpathSync.native(resolved));
  } catch {
    // Use the resolved path when the worktree directory does not yet exist.
  }

  return [...variants].map((basePath) => `${basePath}${path.sep}${cli}-`);
}

function worktreePathMatchesPrefixes(
  worktreePath: string,
  prefixes: string[],
): boolean {
  const variants = new Set<string>();
  variants.add(worktreePath);

  try {
    variants.add(realpathSync.native(worktreePath));
  } catch {
    // Worktree list entries normally exist; fall back to the reported path.
  }

  return [...variants].some((candidatePath) =>
    prefixes.some((prefix) => candidatePath.startsWith(prefix))
  );
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
  await runGit(["-C", repoRoot, "worktree", "prune"]);
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
        const diffResult =
          await runGit(["-C", entry.path, "diff", "--quiet"]);
        const diffCachedResult =
          await runGit(["-C", entry.path, "diff", "--cached", "--quiet"]);
        if (diffResult.exitCode !== 0 || diffCachedResult.exitCode !== 0) {
          log.info(
            `Skipping reused worktree ${entry.path}: local changes prevent switching to ${desiredBranchName}.`,
          );
          releaseWorktreeLock(lockDir);
          continue;
        }

        const cleanResult =
          await runGit(["-C", entry.path, "clean", "-fd"]);
        if (cleanResult.exitCode !== 0) {
          log.info(
            `Skipping reused worktree ${entry.path}: failed to remove untracked files before switching to ${desiredBranchName}.`,
          );
          releaseWorktreeLock(lockDir);
          continue;
        }

        const checkoutResult =
          await runGit([
            "-C",
            entry.path,
            "checkout",
            "-B",
            desiredBranchName,
            targetRef(branchTarget),
          ]);
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
    await runGit([
      "-C",
      repoRoot,
      "worktree",
      "add",
      "-b",
      branchName,
      worktreePath,
      targetRef(branchTarget),
    ]);
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
      await runGit(["-C", repoRoot, "worktree", "remove", "--force", worktreePath]);
      await runGit(["-C", repoRoot, "branch", "-D", branchName]);
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
    await runGit(["-C", repoRoot, "worktree", "remove", "--force", worktreePath]);
    await runGit(["-C", repoRoot, "branch", "-D", branchName]);
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
