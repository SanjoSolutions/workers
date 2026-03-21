#!/usr/bin/env node

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { parseCliOptions } from "../cli.js";
import { loadConfig } from "../config.js";
import { selectWorktree } from "../worktree.js";
import { computeRuntimeInfo } from "../runtime.js";
import {
  rebaseWorktreeOntoRoot,
  repairReusedWorktreeAfterRebaseFailure,
} from "../git-sync.js";
import { launchAgent } from "../agent.js";
import {
  cleanup,
  cleanupStaleWorktrees,
  setupSignalHandlers,
} from "../cleanup.js";
import * as log from "../log.js";
import type { CliOptions, RuntimeInfo, WorkConfig, WorktreeInfo } from "../types.js";
import {
  fetchBranchTarget,
  resolveBranchTarget,
  type GitBranchTarget,
} from "../git-target.js";
import { resolveProjectWorktreeDir } from "../worktree-paths.js";
import {
  ensureTaskRepo,
  resolveClaimedItemTarget,
} from "../task-target.js";
import { initializeProject, isCreatePullRequestEnabled, loadSettings, persistProjectSettings } from "../settings.js";
import {
  applyGitHubTokenForRepo,
  applyGitHubTokenFromSettings,
  resolvePollingTaskTrackers,
} from "../task-tracker-settings.js";
import {
  syncClaimedItemToLocal,
  syncCompletedItem,
} from "../task-trackers.js";
import { readEnv } from "../env-utils.js";
import { findGitRepoRoot } from "../git-utils.js";
import { createWorkerPullRequest } from "../github-pr.js";
import { claimNextItemFromTrackers } from "../worker-claim-selection.js";

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

export function finishedBranchFollowUpMessage(
  createPullRequestEnabled: boolean,
): string {
  return createPullRequestEnabled
    ? "Use this branch to review or open a pull request, then remove it when done."
    : "Use this branch for review/cherry-pick/merge, then remove it when done.";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    if (config.runtime) {
      runtimeInfo = computeRuntimeInfo(repoRoot, options.cli, worktree.path);
      await config.runtime.setup(runtimeInfo, worktree.path, repoRoot);
    }

    if (runtimeInfo && config.runtime?.printStatus) {
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
  createPullRequestEnabled: boolean,
): Promise<void> {
  if (!options.cleanup) {
    console.log();
    log.info(`Finished. Worktree left in place: ${workspace.worktree.path}`);
    if (workspace.runtimeInfo) {
      log.info("Isolated runtime is still running for reuse.");
    }
    log.info(finishedBranchFollowUpMessage(createPullRequestEnabled));
  }

  await cleanup(
    workspace.repoRoot,
    options,
    workspace.worktree,
    workspace.worktreeLockDir,
    workspace.stopRuntime,
  );
}

async function runNoTodoMode(
  options: CliOptions,
  invocationRepoRoot: string | null,
): Promise<void> {
  if (!invocationRepoRoot) {
    throw new Error("`--no-todo` requires running workers from a git repository.");
  }

  let activeWorkspace: ActiveWorkspace | null = null;
  let createPullRequestEnabled = false;
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
    log.info("Launching agent without TODO (--no-todo mode).");
    const agentEnv: NodeJS.ProcessEnv = { ...process.env };
    const settings = await loadSettings();
    createPullRequestEnabled = isCreatePullRequestEnabled(
      invocationRepoRoot,
      settings.projects,
    );
    await applyGitHubTokenForRepo(settings, invocationRepoRoot, agentEnv);
    const agentResult = await launchAgent(
      options,
      activeWorkspace.worktree.path,
      "",
      "",
      activeWorkspace.config,
      agentEnv,
      invocationRepoRoot,
    );

    if (agentResult.exitCode !== 0) {
      log.info(`${options.cli} exited with error (${agentResult.exitCode}).`);
      process.exitCode = agentResult.exitCode;
    }
  } finally {
    await finalizeWorkspace(activeWorkspace, options, createPullRequestEnabled);
  }
}

export async function runWorkerCli(argv = process.argv): Promise<void> {
  const options = await parseCliOptions(argv);
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
    await applyGitHubTokenFromSettings(settings);
    const pollableTrackers = resolvePollingTaskTrackers(settings);

    if (pollableTrackers.length === 0) {
      throw new Error(
        "No task trackers are configured. Set a default task tracker in settings.json or WORKERS_TODO_REPO in the environment.",
      );
    }

    const claimAttempt = await claimNextItemFromTrackers(
      pollableTrackers,
      options.cli,
      invocationPath,
    );
    if (!("claimedItem" in claimAttempt)) {
      if (claimAttempt.reason === "no-matching-agent") {
        log.info("No claimable items (no-matching-agent). Polling...");
      } else {
        log.info("No claimable items. Polling for new items...");
      }
      await sleep(pollIntervalMs);
      continue;
    }
    const { claimedItem } = claimAttempt;

    if (!firstTask) {
      console.log();
    }
    firstTask = false;
    taskSequence += 1;
    log.heading("=== Starting next item ===");
    log.info(`Claiming item: ${claimedItem.item.split("\n")[0]}`);
    log.info(`Claimed item in task tracker: ${claimedItem.trackerName}.`);

    try {
      let createPullRequestEnabled = false;
      const target = resolveClaimedItemTarget(
        claimedItem.item,
        claimedItem.itemType,
        claimedItem.trackerBasePath,
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

      if (ensuredRepo.bootstrapped) {
        initializeProject(ensuredRepo.repoRoot);
      }

      activeWorkspace = await setupWorkspaceForRepo(
        ensuredRepo.repoRoot,
        options,
        buildSessionTag(options.cli, taskSequence),
      );
      console.log();

      syncClaimedItemToLocal(claimedItem, activeWorkspace.localTodoPath);

      const agentEnv: NodeJS.ProcessEnv = { ...process.env };
      const launchSettings = await loadSettings();
      await applyGitHubTokenForRepo(launchSettings, ensuredRepo.repoRoot, agentEnv);
      const agentResult = await launchAgent(
        options,
        activeWorkspace.worktree.path,
        claimedItem.item,
        claimedItem.itemType,
        activeWorkspace.config,
        agentEnv,
        ensuredRepo.repoRoot,
      );

      const completionSync = await syncCompletedItem(
        claimedItem,
        activeWorkspace.localTodoPath,
      );
      if (completionSync.status === "pending") {
        log.info(
          "Claimed item is still present in the local TODO copy; skipping task tracker completion sync.",
        );
      } else {
        log.info("Synced item completion to task tracker.");
      }

      const currentSettings = await loadSettings();
      createPullRequestEnabled = isCreatePullRequestEnabled(
        activeWorkspace.repoRoot,
        currentSettings.projects,
      );
      if (createPullRequestEnabled) {
        const prResult = await createWorkerPullRequest({
          repoRoot: activeWorkspace.repoRoot,
          branchName: activeWorkspace.worktree.branchName,
          claimedItem,
        });
        if (prResult.status === "created") {
          log.info(`GitHub PR created: ${prResult.url}`);
        } else if (prResult.status === "skipped") {
          log.info(`Skipped GitHub PR creation (${prResult.reason}).`);
        } else {
          log.info(`GitHub PR creation failed: ${prResult.reason}`);
        }
      }

      if (agentResult.exitCode !== 0) {
        log.info(`${options.cli} exited with error (${agentResult.exitCode}).`);
      }
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      break;
    } finally {
      if (activeWorkspace) {
        const currentSettings = await loadSettings();
        await finalizeWorkspace(
          activeWorkspace,
          options,
          isCreatePullRequestEnabled(activeWorkspace.repoRoot, currentSettings.projects),
        );
        activeWorkspace = null;
      }
    }

    await sleep(2000);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runWorkerCli().catch((err) => {
    log.error(
      `Unhandled error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });
}
