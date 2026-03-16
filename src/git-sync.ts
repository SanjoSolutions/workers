import { readFileSync } from "fs";
import { $ } from "zx";
import type { WorkConfig } from "./types.js";
import * as log from "./log.js";
import {
  fetchBranchTarget,
  targetRef,
  type GitBranchTarget,
} from "./git-target.js";

export function hasTodos(todoFilePath: string): boolean {
  let content: string;
  try {
    content = readFileSync(todoFilePath, "utf8");
  } catch {
    return false;
  }

  const lines = content.split("\n");
  let inReadySection = false;

  for (const line of lines) {
    if (/^## Ready to be picked up$/.test(line)) {
      inReadySection = true;
      continue;
    }
    if (inReadySection && /^## /.test(line)) {
      break;
    }
    if (inReadySection && /^- /.test(line)) {
      return true;
    }
  }

  return false;
}

export async function rebaseWorktreeOntoRoot(
  repoRoot: string,
  worktreePath: string,
  branchTarget: GitBranchTarget,
): Promise<boolean> {
  await fetchBranchTarget(repoRoot, branchTarget);

  const branchTargetResult =
    await $`git -C ${repoRoot} rev-parse ${targetRef(branchTarget)}`
      .quiet()
      .nothrow();
  const currentHeadResult =
    await $`git -C ${worktreePath} rev-parse HEAD`.quiet().nothrow();

  const branchTargetHead = branchTargetResult.stdout.trim();
  const currentHead = currentHeadResult.stdout.trim();

  if (!branchTargetHead || !currentHead) {
    log.error(
      `Failed to resolve ${branchTarget.displayName} or worktree HEAD during rebase sync.`,
    );
    return false;
  }

  if (branchTargetHead === currentHead) {
    return true;
  }

  const diffResult =
    await $`git -C ${worktreePath} diff --quiet`.quiet().nothrow();
  const diffCachedResult =
    await $`git -C ${worktreePath} diff --cached --quiet`.quiet().nothrow();

  if (diffResult.exitCode !== 0 || diffCachedResult.exitCode !== 0) {
    log.error(
      `Worktree has local uncommitted changes; cannot auto-sync with latest ${branchTarget.displayName}.`,
    );
    return false;
  }

  log.info(`Rebasing worktree onto ${branchTarget.displayName} (${branchTargetHead}).`);
  const rebaseResult =
    await $`git -C ${worktreePath} rebase ${branchTargetHead}`.quiet().nothrow();
  if (rebaseResult.exitCode !== 0) {
    log.error("Worktree rebase failed. Aborting rebase.");
    await $`git -C ${worktreePath} rebase --abort`.quiet().nothrow();
    return false;
  }

  return true;
}

export async function repairReusedWorktreeAfterRebaseFailure(
  repoRoot: string,
  worktreePath: string,
  branchName: string,
  branchTarget: GitBranchTarget,
): Promise<boolean> {
  if (!branchName) {
    const worktreeBasename = worktreePath.split("/").pop() ?? "repaired";
    const newBranch = `work/${worktreeBasename}`;
    log.info(
      `Worktree is detached; creating branch ${newBranch} at ${branchTarget.displayName}.`,
    );
    const createResult =
      await $`git -C ${repoRoot} branch ${newBranch} ${targetRef(branchTarget)}`
        .quiet()
        .nothrow();
    if (createResult.exitCode !== 0) {
      await $`git -C ${repoRoot} branch -f ${newBranch} ${targetRef(branchTarget)}`
        .quiet()
        .nothrow();
    }
    await $`git -C ${worktreePath} checkout -- .`.quiet().nothrow();
    await $`git -C ${worktreePath} clean -fd`.quiet().nothrow();

    const checkoutResult =
      await $`git -C ${worktreePath} checkout ${newBranch}`
        .quiet()
        .nothrow();
    if (checkoutResult.exitCode !== 0) {
      log.error(
        `Cannot repair detached worktree: failed to checkout ${newBranch}.`,
      );
      return false;
    }
    log.info(`Repaired detached worktree by checking out ${newBranch}.`);
    return true;
  }

  const currentHeadResult =
    await $`git -C ${worktreePath} rev-parse HEAD`.quiet().nothrow();
  const currentHead = currentHeadResult.stdout.trim();

  if (!currentHead) {
    log.error(
      "Cannot repair reused worktree: failed to resolve current HEAD.",
    );
    return false;
  }

  const timestamp = new Date()
    .toISOString()
    .replace(/[T:]/g, "-")
    .replace(/\..+$/, "");
  const backupBranch = `${branchName}-backup-${timestamp}`;

  const backupResult =
    await $`git -C ${repoRoot} branch ${backupBranch} ${currentHead}`
      .quiet()
      .nothrow();
  if (backupResult.exitCode !== 0) {
    log.error(
      `Cannot repair reused worktree: failed to create backup branch ${backupBranch}.`,
    );
    return false;
  }

  const detachResult =
    await $`git -C ${worktreePath} checkout --detach`.quiet().nothrow();
  if (detachResult.exitCode !== 0) {
    log.error(
      "Cannot repair reused worktree: failed to detach HEAD before branch realignment.",
    );
    return false;
  }

  const resetResult =
    await $`git -C ${repoRoot} branch -f ${branchName} ${targetRef(branchTarget)}`
      .quiet()
      .nothrow();
  if (resetResult.exitCode !== 0) {
    log.error(
      `Cannot repair reused worktree: failed to reset ${branchName} to ${branchTarget.displayName}.`,
    );
    return false;
  }

  const checkoutResult =
    await $`git -C ${worktreePath} checkout ${branchName}`
      .quiet()
      .nothrow();
  if (checkoutResult.exitCode !== 0) {
    log.error(
      `Cannot repair reused worktree: failed to re-checkout ${branchName}.`,
    );
    return false;
  }

  log.info(
    `Repaired reused worktree branch ${branchName} by aligning it to ${branchTarget.displayName}.`,
  );
  log.info(`Backup branch retained: ${backupBranch} (${currentHead}).`);
  return true;
}

export async function verifyAgentPushed(
  repoRoot: string,
  worktreePath: string,
  beforeHead: string,
  branchTarget: GitBranchTarget,
): Promise<boolean> {
  const afterHeadResult =
    await $`git -C ${worktreePath} rev-parse HEAD`.quiet().nothrow();
  const afterHead = afterHeadResult.stdout.trim();

  if (!afterHead || afterHead === beforeHead) {
    log.error(
      "Agent finished without creating any commits; commit required.",
    );
    return false;
  }

  await fetchBranchTarget(repoRoot, branchTarget);

  const branchTargetResult =
    await $`git -C ${repoRoot} rev-parse ${targetRef(branchTarget)}`
      .quiet()
      .nothrow();
  const branchTargetHead = branchTargetResult.stdout.trim();

  if (!branchTargetHead) {
    log.error(`Failed to resolve ${branchTarget.displayName} for push verification.`);
    return false;
  }

  const isAncestorResult =
    await $`git -C ${repoRoot} merge-base --is-ancestor ${afterHead} ${branchTargetHead}`
      .quiet()
      .nothrow();

  if (isAncestorResult.exitCode === 0) {
    return true;
  }

  const originAdvancedResult =
    await $`git -C ${repoRoot} merge-base --is-ancestor ${beforeHead} ${branchTargetHead}`
      .quiet()
      .nothrow();

  if (originAdvancedResult.exitCode === 0 && branchTargetHead !== beforeHead) {
    log.info(
      `Agent commits reached ${branchTarget.displayName} (rebased to different SHAs).`,
    );
    return true;
  }

  log.error(
    `Agent commits were NOT pushed to ${branchTarget.displayName}. Worktree HEAD: ${afterHead}, ${branchTarget.displayName}: ${branchTargetHead}.`,
  );
  return false;
}

/**
 * Push the worktree's HEAD to origin/main, handling rebase conflicts.
 *
 * Auto-resolves conflicts on configurable files (default: TODO.md) by
 * accepting theirs (origin/main version). Calls config.git.afterRebase
 * after each successful rebase.
 */
export async function pushWorktreeToMain(
  repoRoot: string,
  worktreePath: string,
  branchTarget: GitBranchTarget,
  config?: WorkConfig,
): Promise<boolean> {
  const MAX_ATTEMPTS = 5;
  const autoResolveFiles = new Set(config?.git?.autoResolveFiles ?? ["TODO.md"]);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const pushResult =
      await $`git -C ${worktreePath} push ${branchTarget.remoteName!} HEAD:${branchTarget.remoteBranch!}`
        .quiet()
        .nothrow();
    if (pushResult.exitCode === 0) {
      log.info(`Pushed commits to ${branchTarget.displayName}.`);
      return true;
    }

    log.info(
      `Push attempt ${attempt}/${MAX_ATTEMPTS} failed. Rebasing onto ${branchTarget.displayName}...`,
    );

    await fetchBranchTarget(repoRoot, branchTarget);

    const rebaseResult =
      await $`git -C ${worktreePath} rebase ${targetRef(branchTarget)}`
        .quiet()
        .nothrow();

    if (rebaseResult.exitCode === 0) {
      if (config?.git?.afterRebase) {
        await config.git.afterRebase(worktreePath);
      }
      continue;
    }

    // Rebase conflict — try to resolve automatically
    log.info("Rebase conflict detected. Attempting auto-resolution...");

    const MAX_CONFLICT_STEPS = 20;
    let resolved = false;
    for (let step = 0; step < MAX_CONFLICT_STEPS; step++) {
      const conflictResult =
        await $`git -C ${worktreePath} diff --name-only --diff-filter=U`
          .quiet()
          .nothrow();
      const conflictFiles = conflictResult.stdout.trim().split("\n").filter(Boolean);

      if (conflictFiles.length === 0) {
        resolved = true;
        break;
      }

      const nonAutoResolve = conflictFiles.filter((f) => !autoResolveFiles.has(f));
      if (nonAutoResolve.length > 0) {
        log.error(
          `Rebase has unresolvable conflicts: ${nonAutoResolve.join(", ")}. Aborting.`,
        );
        await $`git -C ${worktreePath} rebase --abort`.quiet().nothrow();
        resolved = false;
        break;
      }

      // Resolve auto-resolve files by accepting theirs
      for (const file of conflictFiles) {
        await $`git -C ${worktreePath} checkout --theirs ${file}`
          .quiet()
          .nothrow();
        await $`git -C ${worktreePath} add ${file}`.quiet().nothrow();
      }

      const continueResult =
        await $`git -C ${worktreePath} rebase --continue`
          .quiet()
          .nothrow();
      if (continueResult.exitCode === 0) {
        resolved = true;
        break;
      }
    }

    if (!resolved) {
      log.error("Failed to auto-resolve rebase conflicts.");
      await $`git -C ${worktreePath} rebase --abort`.quiet().nothrow();
      return false;
    }

    if (config?.git?.afterRebase) {
      await config.git.afterRebase(worktreePath);
    }
  }

  log.error(`Failed to push to ${branchTarget.displayName} after all attempts.`);
  return false;
}
