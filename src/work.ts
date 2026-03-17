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

interface SharedTodoPaths {
  sharedTodoPath: string;
  sharedTodoRepoRoot: string;
  sharedTodoRelativePath: string;
}

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

async function resolveSharedTodoPaths(basePath: string): Promise<SharedTodoPaths> {
  const sharedRepoPath = readEnv("WORKERS_TODO_REPO");
  if (!sharedRepoPath) {
    throw new Error(
      "WORKERS_TODO_REPO is required. Point it at the shared TODO git repo.",
    );
  }

  const sharedFilePath = readEnv("WORKERS_TODO_FILE") ?? "TODO.md";
  const sharedTodoRepoRoot =
    await resolveGitRepoRoot(path.resolve(basePath, sharedRepoPath));
  const sharedTodoPath = path.resolve(sharedTodoRepoRoot, sharedFilePath);
  const sharedTodoRelativePath = path.relative(sharedTodoRepoRoot, sharedTodoPath);

  return {
    sharedTodoPath,
    sharedTodoRepoRoot,
    sharedTodoRelativePath,
  };
}

function resolveLocalTodoPath(worktreePath: string): string {
  const localPath = readEnv("WORKERS_LOCAL_TODO_PATH") ?? "TODO.md";
  return path.resolve(worktreePath, localPath);
}

function syncTodoToLocal(sharedTodoPath: string, localTodoPath: string): void {
  const content = readFileSync(sharedTodoPath, "utf8");
  mkdirSync(path.dirname(localTodoPath), { recursive: true });
  writeFileSync(localTodoPath, content, "utf8");
}

async function fastForwardRepo(repoRoot: string): Promise<boolean> {
  const branchTarget = await resolveBranchTarget(repoRoot);
  if (!branchTarget.hasRemote) {
    return true;
  }

  const fetchResult = await fetchBranchTarget(repoRoot, branchTarget);
  if (!fetchResult) {
    return false;
  }

  const pullResult =
    await $`git -C ${repoRoot} pull --ff-only ${branchTarget.remoteName!} ${branchTarget.remoteBranch!}`
      .quiet()
      .nothrow();
  return pullResult.exitCode === 0;
}

async function commitAndPushTodoRepo(
  repoRoot: string,
  todoRelativePath: string,
  message: string,
): Promise<boolean> {
  const branchTarget = await resolveBranchTarget(repoRoot);
  const branch = branchTarget.branch;

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
    if (!branchTarget.hasRemote) {
      return true;
    }

    const pushResult =
      await $`git -C ${repoRoot} push ${branchTarget.remoteName!} HEAD:${branch}`.quiet().nothrow();
    if (pushResult.exitCode === 0) {
      return true;
    }

    const rebaseResult =
      await $`git -C ${repoRoot} pull --rebase ${branchTarget.remoteName!} ${branch}`
        .quiet()
        .nothrow();
    if (rebaseResult.exitCode !== 0) {
      return false;
    }
  }

  return false;
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

async function claimTodo(
  sharedTodo: SharedTodoPaths,
  cli: string,
): Promise<ReturnType<typeof claimFromTodoText>> {
  return withTodoLock(sharedTodo.sharedTodoPath, async () => {
    const content = readFileSync(sharedTodo.sharedTodoPath, "utf8");
    const claimResult = claimFromTodoText(content, { agent: cli });
    if (claimResult.status !== "claimed") {
      return claimResult;
    }

    writeFileSync(sharedTodo.sharedTodoPath, claimResult.updatedContent, "utf8");

    const claimSummary = claimResult.item
      .split("\n")[0]
      .replace(/^- /, "");
    const pushed = await commitAndPushTodoRepo(
      sharedTodo.sharedTodoRepoRoot,
      sharedTodo.sharedTodoRelativePath,
      `chore(todo): claim TODO — ${claimSummary}`,
    );
    if (!pushed) {
      throw new Error("Failed to commit/push claimed TODO in shared TODO repo.");
    }

    return claimResult;
  });
}

async function syncCompletedTodo(
  sharedTodo: SharedTodoPaths,
  localTodoPath: string,
  claimedSummary: string,
): Promise<void> {
  const localTodoContent = readFileSync(localTodoPath, "utf8");
  if (todoContainsSummary(localTodoContent, claimedSummary)) {
    log.info(
      "Claimed TODO is still present in the local TODO copy; skipping shared TODO completion sync.",
    );
    return;
  }

  const syncedCompletion = await withTodoLock(
    sharedTodo.sharedTodoPath,
    async () => {
      const sharedContent = readFileSync(sharedTodo.sharedTodoPath, "utf8");
      const removal = removeInProgressItemBySummary(sharedContent, claimedSummary);
      if (removal.status !== "removed") {
        return true;
      }

      writeFileSync(sharedTodo.sharedTodoPath, removal.updatedContent, "utf8");
      return commitAndPushTodoRepo(
        sharedTodo.sharedTodoRepoRoot,
        sharedTodo.sharedTodoRelativePath,
        `chore(todo): complete TODO — ${claimedSummary}`,
      );
    },
  );

  if (!syncedCompletion) {
    throw new Error("Failed to commit/push completed TODO in shared TODO repo.");
  }

  syncTodoToLocal(sharedTodo.sharedTodoPath, localTodoPath);
  log.info("Synced TODO completion to shared TODO repo.");
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

  const sharedTodo = await resolveSharedTodoPaths(invocationPath);
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
    if (!(await fastForwardRepo(sharedTodo.sharedTodoRepoRoot))) {
      throw new Error("Failed to sync shared TODO repo.");
    }

    if (!hasTodos(sharedTodo.sharedTodoPath)) {
      log.info("No claimable TODOs. Polling for new TODOs...");
      await sleep(pollIntervalMs);
      continue;
    }

    const claimResult = await claimTodo(sharedTodo, options.cli);
    if (claimResult.status !== "claimed") {
      log.info(`No claimable TODOs (${claimResult.reason}). Polling...`);
      await sleep(pollIntervalMs);
      continue;
    }

    if (!firstTask) {
      console.log();
    }
    firstTask = false;
    taskSequence += 1;
    log.heading("=== Starting next TODO ===");
    log.info(`Claiming TODO: ${claimResult.item.split("\n")[0]}`);
    log.info("Claimed and pushed TODO in shared TODO repo.");

    try {
      const target = resolveClaimedTaskTarget(
        claimResult.item,
        claimResult.itemType,
        sharedTodo.sharedTodoRepoRoot,
      );
      const ensuredRepo = await ensureTaskRepo(target);
      if (target.source === "no-repo") {
        log.info(`Using no-repo scratch workspace: ${ensuredRepo.repoRoot}`);
      } else if (ensuredRepo.bootstrapped) {
        log.info(`Bootstrapped new repo at ${ensuredRepo.repoRoot}.`);
      } else {
        log.info(`Resolved target repo: ${ensuredRepo.repoRoot}`);
      }

      activeWorkspace = await setupWorkspaceForRepo(
        ensuredRepo.repoRoot,
        options,
        buildSessionTag(options.cli, taskSequence),
      );
      console.log();

      syncTodoToLocal(sharedTodo.sharedTodoPath, activeWorkspace.localTodoPath);

      if (options.setupOnly) {
        log.success("Setup complete for claimed TODO. Exiting (--setup-only).");
        return;
      }

      const agentResult = await launchAgent(
        options,
        activeWorkspace.worktree.path,
        claimResult.item,
        claimResult.itemType,
        activeWorkspace.config,
      );

      const claimedSummary = claimResult.item.split("\n")[0].replace(/^- /, "");
      await syncCompletedTodo(
        sharedTodo,
        activeWorkspace.localTodoPath,
        claimedSummary,
      );

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
