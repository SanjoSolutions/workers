import { $ } from "zx";
import { releaseWorktreeLock, isWorktreeLockedByLiveProcess } from "./locking.js";
import { listCliWorktrees } from "./worktree.js";
import type { CliOptions, WorktreeInfo } from "./types.js";
import * as log from "./log.js";

export async function cleanup(
  repoRoot: string,
  options: CliOptions,
  worktree: WorktreeInfo | null,
  worktreeLockDir: string,
  stopRuntime?: (worktreePath: string) => Promise<void>,
): Promise<void> {
  releaseWorktreeLock(worktreeLockDir);

  if (options.cleanup && worktree) {
    if (stopRuntime) {
      await stopRuntime(worktree.path).catch(() => {});
    }

    await $`git -C ${repoRoot} worktree remove --force ${worktree.path}`
      .quiet()
      .nothrow()
      .then(() => {
        if (worktree.branchName) {
          return $`git -C ${repoRoot} branch -D ${worktree.branchName}`
            .quiet()
            .nothrow();
        }
      })
      .catch(() => {});
  }
}

export async function cleanupStaleWorktrees(
  repoRoot: string,
  worktreeDir: string,
  options: CliOptions,
  keepPath: string,
  worktreeLockRoot: string,
  stopRuntime?: (worktreePath: string) => Promise<void>,
): Promise<void> {
  const entries = await listCliWorktrees(repoRoot, worktreeDir, options.cli);

  for (const entry of entries) {
    if (entry.path === keepPath) {
      continue;
    }

    const locked = isWorktreeLockedByLiveProcess(
      worktreeLockRoot,
      entry.path,
    );
    if (locked) {
      log.info(`Skipping stale cleanup for active worktree: ${entry.path}`);
      continue;
    }

    if (stopRuntime) {
      await stopRuntime(entry.path).catch(() => {});
    }

    log.info(`Removing stale worktree: ${entry.path}`);
    await $`git -C ${repoRoot} worktree remove --force ${entry.path}`
      .quiet()
      .nothrow();

    if (entry.branchRef) {
      const branchShort = entry.branchRef.replace(/^refs\/heads\//, "");
      await $`git -C ${repoRoot} branch -D ${branchShort}`
        .quiet()
        .nothrow();
    }
  }
}

export function setupSignalHandlers(cleanupFn: () => Promise<void>): void {
  const handler = () => {
    log.info("Stopping.");
    cleanupFn().then(
      () => process.exit(130),
      () => process.exit(130),
    );
  };

  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}
