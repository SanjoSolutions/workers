#!/usr/bin/env tsx

import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { $ } from "zx";
import { claimFromTodoText } from "./claim-todo.js";
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
  const { mkdirSync } = await import("fs");
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

    const worktreeTodoFile = path.join(worktree.path, "TODO.md");

    if (!hasTodos(worktreeTodoFile)) {
      log.info("No claimable TODOs. Polling for new TODOs...");
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      continue;
    }

    // Claim the next TODO atomically
    const MAX_CLAIM_ATTEMPTS = 5;
    let claimResult: ReturnType<typeof claimFromTodoText> | null = null;

    for (let attempt = 1; attempt <= MAX_CLAIM_ATTEMPTS; attempt++) {
      const content = readFileSync(worktreeTodoFile, "utf8");
      claimResult = claimFromTodoText(content, { agent: options.cli });

      if (claimResult.status !== "claimed") {
        break;
      }

      if (attempt === 1) {
        if (!first) console.log();
        first = false;
        log.heading("=== Starting next TODO ===");
      }
      log.info(`Claiming TODO: ${claimResult.item.split("\n")[0]}`);

      writeFileSync(worktreeTodoFile, claimResult.updatedContent, "utf8");
      const rootTodoFile = path.join(repoRoot, "TODO.md");
      if (rootTodoFile !== worktreeTodoFile) {
        writeFileSync(rootTodoFile, claimResult.updatedContent, "utf8");
      }

      const claimSummary = claimResult.item.split("\n")[0].replace(/^- /, "");
      const commitResult =
        await $`git -C ${worktree.path} add TODO.md && git -C ${worktree.path} commit -m ${"chore(todo): claim TODO — " + claimSummary}`
          .quiet()
          .nothrow();

      if (commitResult.exitCode !== 0) {
        log.error("Failed to commit TODO claim.");
        await $`git -C ${worktree.path} checkout -- TODO.md`.quiet().nothrow();
        claimResult = null;
        break;
      }

      const pushResult =
        await $`git -C ${worktree.path} push origin HEAD:main`
          .quiet()
          .nothrow();
      if (pushResult.exitCode === 0) {
        log.info("Claimed and pushed TODO.");
        break;
      }

      log.info(
        `Claim push attempt ${attempt}/${MAX_CLAIM_ATTEMPTS} failed. Fetching latest TODO.md and retrying...`,
      );
      await $`git -C ${worktree.path} reset --soft HEAD~1`.quiet().nothrow();
      await $`git -C ${worktree.path} checkout -- TODO.md`.quiet().nothrow();
      await $`git -C ${repoRoot} fetch origin`.quiet().nothrow();
      const ffResult =
        await $`git -C ${worktree.path} pull --ff-only origin main`
          .quiet()
          .nothrow();
      if (ffResult.exitCode !== 0) {
        await $`git -C ${worktree.path} reset --hard origin/main`
          .quiet()
          .nothrow();
      }

      if (attempt === MAX_CLAIM_ATTEMPTS) {
        log.error("Failed to push TODO claim after all retries.");
        claimResult = null;
      }
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
