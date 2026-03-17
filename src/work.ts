#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { $ } from "zx";
import { parseCliOptions } from "./cli.js";
import { loadConfig } from "./config.js";
import { selectWorktree } from "./worktree.js";
import { computeRuntimeInfo } from "./runtime.js";
import {
  rebaseWorktreeOntoRoot,
  repairReusedWorktreeAfterRebaseFailure,
} from "./git-sync.js";
import { launchAgent } from "./agent.js";
import {
  cleanup,
  cleanupStaleWorktrees,
  setupSignalHandlers,
} from "./cleanup.js";
import * as log from "./log.js";
import type { CliOptions, RuntimeInfo, WorkConfig, WorktreeInfo } from "./types.js";
import {
  fetchBranchTarget,
  resolveBranchTarget,
  type GitBranchTarget,
} from "./git-target.js";
import { resolveProjectWorktreeDir } from "./worktree-paths.js";
import {
  ensureTaskRepo,
  resolveClaimedTaskTarget,
} from "./task-target.js";
import { loadSettings, persistProjectSettings } from "./settings.js";
import {
  resolvePollingTaskTrackers,
} from "./task-tracker-settings.js";
import {
  claimTaskFromTracker,
  syncClaimedTaskToLocal,
  syncCompletedTask,
  type ClaimedTask,
} from "./task-trackers.js";

interface ActiveWorkspace {
  repoRoot: string;
  config: WorkConfig;
  branchTarget: GitBranchTarget;
  worktree: WorktreeInfo;
  worktreeLockDir: string;
  stopRuntime?: (worktreePath: string) => Promise<void>;
  runtimeInfo: RuntimeInfo | null;
  localTodoPath: string;
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveGitRepoRoot(startPath: string): Promise<string> {
  const result =
    await $`git -C ${startPath} rev-parse --show-toplevel`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`Cannot find git repository for ${startPath}`);
  }
  return result.stdout.trim();
}

async function findGitRepoRoot(startPath: string): Promise<string | undefined> {
  const result =
    await $`git -C ${startPath} rev-parse --show-toplevel`.quiet().nothrow();
  if (result.exitCode !== 0) {
    return undefined;
  }
  const repoRoot = result.stdout.trim();
  return repoRoot || undefined;
}

function resolveLocalTodoPath(worktreePath: string): string {
  const localPath = readEnv("WORKERS_LOCAL_TODO_PATH") ?? "TODO.md";
  return path.resolve(worktreePath, localPath);
}

function buildSessionTag(cli: string, sequence: number): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[T:]/g, "")
    .replace(/\..+$/, "")
    .replace(/-/g, "")
    .slice(0, 15);
  return `${cli}-${timestamp}-${process.pid}-${sequence}`;
}

async function setupWorkspaceForRepo(
  repoRoot: string,
  options: CliOptions,
  sessionTag: string,
): Promise<ActiveWorkspace> {
  const config = await loadConfig(repoRoot);
  log.info(`Project: ${config.projectName}`);

  const branchTarget = await resolveBranchTarget(repoRoot);
  if (branchTarget.hasRemote) {
    const fetchResult = await fetchBranchTarget(repoRoot, branchTarget);
    if (!fetchResult) {
      throw new Error(
        `Failed to fetch latest changes from ${branchTarget.displayName}.`,
      );
    }
    log.info(`Fetched latest changes from ${branchTarget.displayName}.`);
  } else {
    log.info(`Using local branch ${branchTarget.branch} as worktree base.`);
  }

  const projectWorktreeDir = resolveProjectWorktreeDir(
    repoRoot,
    options.worktreeDir,
  );
  mkdirSync(projectWorktreeDir, { recursive: true });

  const worktreeLockRoot = path.join(repoRoot, ".git", "worktree-active-locks");
  const stopRuntime = config.runtime?.stop
    ? async (wtPath: string) => {
        const info = computeRuntimeInfo(repoRoot, options.cli, wtPath);
        await config.runtime!.stop(info, wtPath, repoRoot);
      }
    : undefined;

  const { worktree, lockDir } = await selectWorktree(
    repoRoot,
    options,
    sessionTag,
    worktreeLockRoot,
    config,
    branchTarget,
    projectWorktreeDir,
  );

  try {
    log.info(`Worktree: ${worktree.path} (${worktree.reuseMode})`);
    log.info(`Branch: ${worktree.branchName || "detached-head"}`);

    const rebaseSuccess = await rebaseWorktreeOntoRoot(
      repoRoot,
      worktree.path,
      branchTarget,
    );
    if (!rebaseSuccess) {
      if (worktree.reuseMode !== "reused") {
        throw new Error(
          "Failed to sync worktree with latest root commits before runtime setup.",
        );
      }

      log.info(
        "Failed to rebase reused worktree onto latest root HEAD. Attempting in-place repair.",
      );

      const repaired = await repairReusedWorktreeAfterRebaseFailure(
        repoRoot,
        worktree.path,
        worktree.branchName,
        branchTarget,
      );
      if (!repaired) {
        throw new Error(
          "Failed to repair reused worktree after rebase failure.",
        );
      }

      const retryRebase = await rebaseWorktreeOntoRoot(
        repoRoot,
        worktree.path,
        branchTarget,
      );
      if (!retryRebase) {
        throw new Error(
          "Failed to sync repaired reused worktree with latest root commits before runtime setup.",
        );
      }
    }

    if (options.cleanupStale) {
      await cleanupStaleWorktrees(
        repoRoot,
        projectWorktreeDir,
        options,
        worktree.path,
        worktreeLockRoot,
        stopRuntime,
      );
    }

    let runtimeInfo: RuntimeInfo | null = null;
    if (options.isolatedRuntime && config.runtime) {
      runtimeInfo = computeRuntimeInfo(repoRoot, options.cli, worktree.path);
      await config.runtime.setup(runtimeInfo, worktree.path, repoRoot);
    }

    if (options.isolatedRuntime && runtimeInfo && config.runtime?.printStatus) {
      config.runtime.printStatus(runtimeInfo);
    }

    return {
      repoRoot,
      config,
      branchTarget,
      worktree,
      worktreeLockDir: lockDir,
      stopRuntime,
      runtimeInfo,
      localTodoPath: resolveLocalTodoPath(worktree.path),
    };
  } catch (error) {
    await cleanup(
      repoRoot,
      { ...options, cleanup: true },
      worktree,
      lockDir,
      stopRuntime,
    );
    throw error;
  }
}

async function finalizeWorkspace(
  workspace: ActiveWorkspace,
  options: CliOptions,
): Promise<void> {
  if (!options.cleanup) {
    console.log();
    log.info(`Finished. Worktree left in place: ${workspace.worktree.path}`);
    if (options.isolatedRuntime && workspace.runtimeInfo) {
      log.info("Isolated runtime is still running for reuse.");
    }
    log.info("Use this branch for review/cherry-pick/merge, then remove it when done.");
  }

  await cleanup(
    workspace.repoRoot,
    options,
    workspace.worktree,
    workspace.worktreeLockDir,
    workspace.stopRuntime,
  );
}

async function claimNextTodo(
  trackers: ReturnType<typeof resolvePollingTaskTrackers>,
  cli: string,
  invocationPath: string,
): Promise<{ claimedTask: ClaimedTask } | { reason: string }> {
  let sawMatchingIssue = false;
  let sawBlockedIssue = false;
  let sawReadyEmpty = false;

  for (const tracker of trackers) {
    const claimResult = await claimTaskFromTracker(tracker, cli, invocationPath);
    if (claimResult.status === "claimed" && claimResult.claimedTask) {
      return {
        claimedTask: claimResult.claimedTask,
      };
    }

    if (claimResult.reason === "all-blocked-by-conflict") {
      sawBlockedIssue = true;
    } else if (claimResult.reason === "no-matching-agent") {
      sawMatchingIssue = true;
    } else if (claimResult.reason === "ready-empty") {
      sawReadyEmpty = true;
    }
  }

  return {
    reason: sawBlockedIssue
      ? "all-blocked-by-conflict"
      : sawMatchingIssue
        ? "no-matching-agent"
        : sawReadyEmpty
          ? "ready-empty"
          : "no-claimable-trackers",
  };
}

async function runNoTodoMode(
  options: CliOptions,
  invocationRepoRoot: string | undefined,
): Promise<void> {
  if (!invocationRepoRoot) {
    throw new Error("`--no-todo` requires running workers from a git repository.");
  }

  let activeWorkspace: ActiveWorkspace | null = null;
  setupSignalHandlers(() =>
    activeWorkspace
      ? cleanup(
          activeWorkspace.repoRoot,
          options,
          activeWorkspace.worktree,
          activeWorkspace.worktreeLockDir,
          activeWorkspace.stopRuntime,
        )
      : Promise.resolve(),
  );

  activeWorkspace = await setupWorkspaceForRepo(
    invocationRepoRoot,
    options,
    buildSessionTag(options.cli, 1),
  );
  console.log();

  try {
    if (options.setupOnly) {
      log.success("Setup complete. Exiting (--setup-only).");
      return;
    }

    log.info("Launching agent without TODO (--no-todo mode).");
    const agentResult = await launchAgent(
      options,
      activeWorkspace.worktree.path,
      "",
      "",
      activeWorkspace.config,
    );

    if (agentResult.exitCode !== 0) {
      log.info(`${options.cli} exited with error (${agentResult.exitCode}).`);
      process.exitCode = agentResult.exitCode;
    }
  } finally {
    await finalizeWorkspace(activeWorkspace, options);
  }
}

async function main(): Promise<void> {
  const options = await parseCliOptions(process.argv);
  const invocationPath = process.cwd();
  const invocationRepoRoot = await findGitRepoRoot(invocationPath);

  if (options.noTodo) {
    await runNoTodoMode(options, invocationRepoRoot);
    return;
  }

  let activeWorkspace: ActiveWorkspace | null = null;

  setupSignalHandlers(() =>
    activeWorkspace
      ? cleanup(
          activeWorkspace.repoRoot,
          options,
          activeWorkspace.worktree,
          activeWorkspace.worktreeLockDir,
          activeWorkspace.stopRuntime,
        )
      : Promise.resolve(),
  );

  const pollIntervalMs = 10_000;
  let firstTask = true;
  let taskSequence = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const settings = await loadSettings();
    const pollableTrackers = resolvePollingTaskTrackers(settings);

    if (pollableTrackers.length === 0) {
      throw new Error(
        "No task trackers are configured. Set a default task tracker in settings.json or WORKERS_TODO_REPO in the environment.",
      );
    }

    const claimAttempt = await claimNextTodo(
      pollableTrackers,
      options.cli,
      invocationPath,
    );
    if (!("claimedTask" in claimAttempt)) {
      if (claimAttempt.reason === "no-matching-agent") {
        log.info("No claimable TODOs (no-matching-agent). Polling...");
      } else {
        log.info("No claimable TODOs. Polling for new TODOs...");
      }
      await sleep(pollIntervalMs);
      continue;
    }
    const { claimedTask } = claimAttempt;

    if (!firstTask) {
      console.log();
    }
    firstTask = false;
    taskSequence += 1;
    log.heading("=== Starting next TODO ===");
    log.info(`Claiming TODO: ${claimedTask.item.split("\n")[0]}`);
    log.info(`Claimed task in task tracker: ${claimedTask.trackerName}.`);

    try {
      const target = resolveClaimedTaskTarget(
        claimedTask.item,
        claimedTask.itemType,
        claimedTask.trackerBasePath,
      );
      const ensuredRepo = await ensureTaskRepo(target);
      if (target.source === "no-repo") {
        log.info(`Using no-repo scratch workspace: ${ensuredRepo.repoRoot}`);
      } else if (ensuredRepo.bootstrapped) {
        log.info(`Bootstrapped new repo at ${ensuredRepo.repoRoot}.`);
        persistProjectSettings([
          {
            repo: ensuredRepo.repoRoot,
          },
        ]);
      } else {
        log.info(`Resolved target repo: ${ensuredRepo.repoRoot}`);
      }

      activeWorkspace = await setupWorkspaceForRepo(
        ensuredRepo.repoRoot,
        options,
        buildSessionTag(options.cli, taskSequence),
      );
      console.log();

      syncClaimedTaskToLocal(claimedTask, activeWorkspace.localTodoPath);

      if (options.setupOnly) {
        log.success("Setup complete for claimed TODO. Exiting (--setup-only).");
        return;
      }

      const agentResult = await launchAgent(
        options,
        activeWorkspace.worktree.path,
        claimedTask.item,
        claimedTask.itemType,
        activeWorkspace.config,
      );

      const completionSync = await syncCompletedTask(
        claimedTask,
        activeWorkspace.localTodoPath,
      );
      if (completionSync.status === "pending") {
        log.info(
          "Claimed TODO is still present in the local TODO copy; skipping task tracker completion sync.",
        );
      } else {
        log.info("Synced TODO completion to task tracker.");
      }

      if (agentResult.exitCode !== 0) {
        log.info(`${options.cli} exited with error (${agentResult.exitCode}).`);
      }
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      break;
    } finally {
      if (activeWorkspace) {
        await finalizeWorkspace(activeWorkspace, options);
        activeWorkspace = null;
      }
    }

    await sleep(2000);
  }
}

main().catch((err) => {
  log.error(
    `Unhandled error: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
