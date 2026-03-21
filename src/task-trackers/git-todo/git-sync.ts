import { runGit } from "../../git-cli.js";
import { fetchBranchTarget, resolveBranchTarget } from "../../git-target.js";

export async function fastForwardRepo(repoRoot: string): Promise<boolean> {
  const branchTarget = await resolveBranchTarget(repoRoot);
  if (!branchTarget.hasRemote) {
    return true;
  }

  const fetchResult = await fetchBranchTarget(repoRoot, branchTarget);
  if (!fetchResult) {
    return false;
  }

  const pullResult = await runGit([
    "-C",
    repoRoot,
    "pull",
    "--ff-only",
    branchTarget.remoteName!,
    branchTarget.remoteBranch!,
  ]);
  return pullResult.exitCode === 0;
}

export async function commitAndPushTodoRepo(
  repoRoot: string,
  todoRelativePath: string,
  message: string,
): Promise<boolean> {
  const branchTarget = await resolveBranchTarget(repoRoot);
  const branch = branchTarget.branch;

  const addResult = await runGit([
    "-C",
    repoRoot,
    "add",
    todoRelativePath,
  ]);
  if (addResult.exitCode !== 0) {
    return false;
  }

  const stagedResult = await runGit([
    "-C",
    repoRoot,
    "diff",
    "--cached",
    "--quiet",
    "--",
    todoRelativePath,
  ]);
  if (stagedResult.exitCode === 0) {
    return true;
  }

  const commitResult = await runGit([
    "-C",
    repoRoot,
    "commit",
    "-m",
    message,
  ]);
  if (commitResult.exitCode !== 0) {
    return false;
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (!branchTarget.hasRemote) {
      return true;
    }

    const pushResult = await runGit([
      "-C",
      repoRoot,
      "push",
      branchTarget.remoteName!,
      `HEAD:${branch}`,
    ]);
    if (pushResult.exitCode === 0) {
      return true;
    }

    const rebaseResult = await runGit([
      "-C",
      repoRoot,
      "pull",
      "--rebase",
      branchTarget.remoteName!,
      branch,
    ]);
    if (rebaseResult.exitCode !== 0) {
      return false;
    }
  }

  return false;
}
