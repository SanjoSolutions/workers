#!/usr/bin/env tsx

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { $ } from "zx";
import {
  claimFromTodoText,
  removeInProgressItemBySummary,
  todoContainsSummary,
  withTodoLock,
} from "./claim-todo.js";
import { parseCliOptions } from "./cli.js";
import { loadConfig } from "./config.js";
import { selectWorktree } from "./worktree.js";
import { computeRuntimeInfo } from "./runtime.js";
import {
  hasTodos,
  pushWorktreeToMain,
  rebaseWorktreeOntoRoot,
  repairReusedWorktreeAfterRebaseFailure,
  verifyAgentPushed,
} from "./git-sync.js";
import { launchAgent } from "./agent.js";
import {
  cleanup,
  cleanupStaleWorktrees,
  setupSignalHandlers,
} from "./cleanup.js";
import * as log from "./log.js";
import type { WorktreeInfo } from "./types.js";

interface TodoPaths {
  localTodoPath: string;
  sharedTodoPath: string;
  sharedTodoRepoRoot: string;
  sharedTodoRelativePath: string;
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

async function resolveGitRepoRoot(startPath: string): Promise<string> {
  const result =
    await $`git -C ${startPath} rev-parse --show-toplevel`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`Cannot find git repository for ${startPath}`);
  }
  return result.stdout.trim();
}

async function resolveTodoPaths(
  repoRoot: string,
  worktreePath: string,
): Promise<TodoPaths> {
  const localPath =
    readEnv("WORKERS_LOCAL_TODO_PATH")
    ?? "TODO.md";
  const sharedRepoPath = readEnv("WORKERS_TODO_REPO");
  const sharedFilePath =
    readEnv("WORKERS_TODO_FILE")
    ?? "TODO.md";

  const localTodoPath = path.resolve(worktreePath, localPath);

  if (!sharedRepoPath) {
    throw new Error(
      "WORKERS_TODO_REPO is required. Point it at the shared TODO git repo.",
    );
  }
  const sharedTodoRepoRoot =
    await resolveGitRepoRoot(path.resolve(repoRoot, sharedRepoPath));
  const sharedTodoPath = path.resolve(sharedTodoRepoRoot, sharedFilePath);

  const sharedTodoRelativePath = path.relative(sharedTodoRepoRoot, sharedTodoPath);

  return {
    localTodoPath,
    sharedTodoPath,
    sharedTodoRepoRoot,
    sharedTodoRelativePath,
  };
}

function syncTodoToLocal(sharedTodoPath: string, localTodoPath: string): void {
  const content = readFileSync(sharedTodoPath, "utf8");
  mkdirSync(path.dirname(localTodoPath), { recursive: true });
  writeFileSync(localTodoPath, content, "utf8");
}

async function getCurrentBranch(repoRoot: string): Promise<string> {
  const result =
    await $`git -C ${repoRoot} rev-parse --abbrev-ref HEAD`.quiet().nothrow();
  const branch = result.stdout.trim();
  if (result.exitCode !== 0 || !branch || branch === "HEAD") {
    throw new Error(`Cannot determine current branch for ${repoRoot}`);
  }
  return branch;
}

async function fastForwardRepo(repoRoot: string): Promise<boolean> {
  const branch = await getCurrentBranch(repoRoot);
  const fetchResult =
    await $`git -C ${repoRoot} fetch origin`.quiet().nothrow();
  if (fetchResult.exitCode !== 0) {
    return false;
  }
  const pullResult =
    await $`git -C ${repoRoot} pull --ff-only origin ${branch}`.quiet().nothrow();
  return pullResult.exitCode === 0;
}

async function commitAndPushTodoRepo(
  repoRoot: string,
  todoRelativePath: string,
  message: string,
): Promise<boolean> {
  const branch = await getCurrentBranch(repoRoot);

  const addResult =
    await $`git -C ${repoRoot} add ${todoRelativePath}`.quiet().nothrow();
  if (addResult.exitCode !== 0) {
    return false;
  }

  const stagedResult =
    await $`git -C ${repoRoot} diff --cached --quiet -- ${todoRelativePath}`
      .quiet()
      .nothrow();
  if (stagedResult.exitCode === 0) {
    return true;
  }

  const commitResult =
    await $`git -C ${repoRoot} commit -m ${message}`.quiet().nothrow();
  if (commitResult.exitCode !== 0) {
    return false;
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const pushResult =
      await $`git -C ${repoRoot} push origin HEAD:${branch}`.quiet().nothrow();
    if (pushResult.exitCode === 0) {
      return true;
    }

    const rebaseResult =
      await $`git -C ${repoRoot} pull --rebase origin ${branch}`.quiet().nothrow();
    if (rebaseResult.exitCode !== 0) {
      return false;
    }
  }

  return false;
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv);

  // Validate git repo
  const repoRoot = process.cwd();
  const gitCheckResult =
    await $`git -C ${repoRoot} rev-parse --show-toplevel`.quiet().nothrow();
  if (gitCheckResult.exitCode !== 0) {
    log.error(`Cannot find git repository at ${repoRoot}`);
    process.exit(1);
  }

  // Load project config
  const config = await loadConfig(repoRoot);
  log.info(`Project: ${config.projectName}`);

  // Fetch latest from origin
  const fetchResult =
    await $`git -C ${repoRoot} fetch origin`.quiet().nothrow();
  if (fetchResult.exitCode !== 0) {
    log.error("Failed to fetch latest changes from origin.");
    if (fetchResult.stderr) log.error(fetchResult.stderr.trim());
    process.exit(1);
  }
  log.info("Fetched latest changes from origin.");

  // Create worktree directory
  mkdirSync(path.join(repoRoot, options.worktreeDir), { recursive: true });

  const sessionTag = `${options.cli}-${new Date().toISOString().replace(/[T:]/g, "").replace(/\..+$/, "").replace(/-/g, "").slice(0, 15)}-${process.pid}`;
  const worktreeLockRoot = path.join(repoRoot, ".git", "worktree-active-locks");

  // Build runtime stop function from config
  const stopRuntime = config.runtime?.stop
    ? async (wtPath: string) => {
        const info = computeRuntimeInfo(repoRoot, options.cli, wtPath);
        await config.runtime!.stop(info, wtPath, repoRoot);
      }
    : undefined;

  // Select worktree
  let worktree: WorktreeInfo;
  let worktreeLockDir: string;
  try {
    const result = await selectWorktree(
      repoRoot,
      options,
      sessionTag,
      worktreeLockRoot,
      config,
    );
    worktree = result.worktree;
    worktreeLockDir = result.lockDir;
  } catch (err) {
    log.error(
      `Failed to select worktree: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  // Change cwd to worktree
  process.chdir(worktree.path);

  const todoConfig = await resolveTodoPaths(repoRoot, worktree.path);

  // Setup signal handlers
  setupSignalHandlers(() =>
    cleanup(repoRoot, options, worktree, worktreeLockDir, stopRuntime),
  );

  log.info(`Worktree: ${worktree.path} (${worktree.reuseMode})`);
  log.info(`Branch: ${worktree.branchName || "detached-head"}`);

  // Initial rebase
  const rebaseSuccess = await rebaseWorktreeOntoRoot(
    repoRoot,
    worktree.path,
  );
  if (!rebaseSuccess) {
    if (worktree.reuseMode === "reused") {
      log.info(
        "Failed to rebase reused worktree onto latest root HEAD. Attempting in-place repair.",
      );

      const repaired = await repairReusedWorktreeAfterRebaseFailure(
        repoRoot,
        worktree.path,
        worktree.branchName,
      );
      if (!repaired) {
        log.error(
          "Failed to repair reused worktree after rebase failure. Stopping.",
        );
        await cleanup(repoRoot, options, worktree, worktreeLockDir, stopRuntime);
        process.exit(1);
      }

      const retryRebase = await rebaseWorktreeOntoRoot(
        repoRoot,
        worktree.path,
      );
      if (!retryRebase) {
        log.error(
          "Failed to sync repaired reused worktree with latest root commits before runtime setup. Stopping.",
        );
        await cleanup(repoRoot, options, worktree, worktreeLockDir, stopRuntime);
        process.exit(1);
      }
    } else {
      log.error(
        "Failed to sync worktree with latest root commits before runtime setup. Stopping.",
      );
      cleanup(repoRoot, options, worktree, worktreeLockDir, stopRuntime);
      process.exit(1);
    }
  }

  // Cleanup stale worktrees
  if (options.cleanupStale) {
    await cleanupStaleWorktrees(
      repoRoot,
      options.worktreeDir,
      options,
      worktree.path,
      worktreeLockRoot,
      stopRuntime,
    );
  }

  // Setup isolated runtime
  let runtimeInfo = null;
  if (options.isolatedRuntime && config.runtime) {
    try {
      runtimeInfo = computeRuntimeInfo(repoRoot, options.cli, worktree.path);
      await config.runtime.setup(runtimeInfo, worktree.path, repoRoot);
    } catch (err) {
      log.error(
        `Failed to start isolated runtime services for worktree ${worktree.path}.`,
      );
      log.error(err instanceof Error ? err.message : String(err));
      if (stopRuntime) {
        await stopRuntime(worktree.path);
      }
      await cleanup(repoRoot, options, worktree, worktreeLockDir, stopRuntime);
      process.exit(1);
    }
  }

  // Print runtime status
  if (options.isolatedRuntime && runtimeInfo && config.runtime?.printStatus) {
    config.runtime.printStatus(runtimeInfo);
  }
  console.log();

  if (!(await fastForwardRepo(todoConfig.sharedTodoRepoRoot))) {
    log.error("Failed to sync shared TODO repo.");
    await cleanup(repoRoot, options, worktree, worktreeLockDir, stopRuntime);
    process.exit(1);
  }

  try {
    syncTodoToLocal(todoConfig.sharedTodoPath, todoConfig.localTodoPath);
  } catch (err) {
    log.error(
      `Failed to sync local TODO copy: ${err instanceof Error ? err.message : String(err)}`,
    );
    await cleanup(repoRoot, options, worktree, worktreeLockDir, stopRuntime);
    process.exit(1);
  }

  // Setup-only mode
  if (options.setupOnly) {
    log.success("Setup complete. Exiting (--setup-only).");
    await cleanup(repoRoot, options, worktree, worktreeLockDir, stopRuntime);
    process.exit(0);
  }

  // --no-todo mode
  if (options.noTodo) {
    log.info("Launching agent without TODO (--no-todo mode).");

    const agentResult = await launchAgent(
      options,
      worktree.path,
      "",
      "",
      config,
    );

    if (agentResult.exitCode !== 0) {
      log.info(
        `${options.cli} exited with error (${agentResult.exitCode}).`,
      );
    }

    await cleanup(repoRoot, options, worktree, worktreeLockDir, stopRuntime);
    process.exit(agentResult.exitCode);
  }

  // TODO loop
  const POLL_INTERVAL_MS = 10_000;
  let first = true;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await $`git -C ${repoRoot} fetch origin`.quiet().nothrow();
    const pullResult =
      await $`git -C ${worktree.path} pull --ff-only origin main`
        .quiet()
        .nothrow();
    if (pullResult.exitCode !== 0) {
      log.error(
        "Failed to pull latest changes into worktree. Stopping.",
      );
      break;
    }

    if (!(await fastForwardRepo(todoConfig.sharedTodoRepoRoot))) {
      log.error("Failed to sync shared TODO repo. Stopping.");
      break;
    }

    try {
      syncTodoToLocal(todoConfig.sharedTodoPath, todoConfig.localTodoPath);
    } catch (err) {
      log.error(
        `Failed to sync local TODO copy: ${err instanceof Error ? err.message : String(err)}`,
      );
      break;
    }

    if (!hasTodos(todoConfig.sharedTodoPath)) {
      log.info("No claimable TODOs. Polling for new TODOs...");
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      continue;
    }

    // Claim the next TODO atomically
    const MAX_CLAIM_ATTEMPTS = 5;
    let claimResult: ReturnType<typeof claimFromTodoText> | null = null;

    for (let attempt = 1; attempt <= MAX_CLAIM_ATTEMPTS; attempt++) {
      try {
        claimResult = await withTodoLock(todoConfig.sharedTodoPath, async () => {
          const content = readFileSync(todoConfig.sharedTodoPath, "utf8");
          const nextClaimResult = claimFromTodoText(content, { agent: options.cli });
          const nextContent =
            nextClaimResult.status === "claimed"
              ? nextClaimResult.updatedContent
              : content;

          mkdirSync(path.dirname(todoConfig.localTodoPath), { recursive: true });
          writeFileSync(todoConfig.localTodoPath, nextContent, "utf8");

          if (nextClaimResult.status !== "claimed") {
            return nextClaimResult;
          }

          writeFileSync(todoConfig.sharedTodoPath, nextClaimResult.updatedContent, "utf8");

          const claimSummary = nextClaimResult.item
            .split("\n")[0]
            .replace(/^- /, "");
          const pushed = await commitAndPushTodoRepo(
            todoConfig.sharedTodoRepoRoot,
            todoConfig.sharedTodoRelativePath,
            `chore(todo): claim TODO — ${claimSummary}`,
          );
          if (!pushed) {
            throw new Error("Failed to commit/push claimed TODO in shared TODO repo.");
          }

          return nextClaimResult;
        });
      } catch (err) {
        log.error(
          err instanceof Error ? err.message : String(err),
        );
        claimResult = null;
        break;
      }

      if (claimResult.status !== "claimed") {
        break;
      }

      if (attempt === 1) {
        if (!first) console.log();
        first = false;
        log.heading("=== Starting next TODO ===");
      }
      log.info(`Claiming TODO: ${claimResult.item.split("\n")[0]}`);
      log.info("Claimed and pushed TODO in shared TODO repo.");
      break;
    }

    if (!claimResult || claimResult.status !== "claimed") {
      if (claimResult && claimResult.status !== "claimed") {
        log.info(`No claimable TODOs (${claimResult.reason}). Polling...`);
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      } else {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      continue;
    }

    // Record HEAD before agent runs
    const beforeHeadResult =
      await $`git -C ${worktree.path} rev-parse HEAD`.quiet().nothrow();
    const beforeHead = beforeHeadResult.stdout.trim();

    // Launch agent
    const agentResult = await launchAgent(
      options,
      worktree.path,
      claimResult.item,
      claimResult.itemType,
      config,
    );

    // Verify agent pushed
    const pushed = await verifyAgentPushed(
      repoRoot,
      worktree.path,
      beforeHead,
    );
    if (!pushed) {
      log.info("Agent did not push to origin/main. Pushing from work.ts...");
      await pushWorktreeToMain(repoRoot, worktree.path, config);
    }

    const claimedSummary = claimResult.item.split("\n")[0].replace(/^- /, "");
    try {
      const localTodoContent = readFileSync(todoConfig.localTodoPath, "utf8");
      if (!todoContainsSummary(localTodoContent, claimedSummary)) {
        const syncedCompletion = await withTodoLock(
          todoConfig.sharedTodoPath,
          async () => {
            const sharedContent = readFileSync(todoConfig.sharedTodoPath, "utf8");
            const removal = removeInProgressItemBySummary(sharedContent, claimedSummary);
            if (removal.status !== "removed") {
              return true;
            }

            writeFileSync(todoConfig.sharedTodoPath, removal.updatedContent, "utf8");
            return commitAndPushTodoRepo(
              todoConfig.sharedTodoRepoRoot,
              todoConfig.sharedTodoRelativePath,
              `chore(todo): complete TODO — ${claimedSummary}`,
            );
          },
        );

        if (!syncedCompletion) {
          log.error("Failed to commit/push completed TODO in shared TODO repo.");
          break;
        }

        syncTodoToLocal(todoConfig.sharedTodoPath, todoConfig.localTodoPath);
        log.info("Synced TODO completion to shared TODO repo.");
      } else {
        log.info(
          "Claimed TODO is still present in the local TODO copy; skipping shared TODO completion sync.",
        );
      }
    } catch (err) {
      log.error(
        `Failed to sync TODO completion: ${err instanceof Error ? err.message : String(err)}`,
      );
      break;
    }

    if (agentResult.exitCode !== 0) {
      log.info(
        `${options.cli} exited with error (${agentResult.exitCode}).`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  // Final status
  if (!options.cleanup) {
    console.log();
    log.info(`Finished. Worktree left in place: ${worktree.path}`);
    if (options.isolatedRuntime && runtimeInfo) {
      log.info(
        "Isolated runtime is still running for reuse.",
      );
    }
    log.info(
      "Use this branch for review/cherry-pick/merge, then remove it when done.",
    );
  }

  await cleanup(repoRoot, options, worktree, worktreeLockDir, stopRuntime);
}

main().catch((err) => {
  log.error(
    `Unhandled error: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
