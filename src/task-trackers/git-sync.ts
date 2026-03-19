import { $ } from "zx";
import { fetchBranchTarget, resolveBranchTarget } from "../git-target.js";

export async function fastForwardRepo(repoRoot: string): Promise<boolean> {
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

export async function commitAndPushTodoRepo(
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
