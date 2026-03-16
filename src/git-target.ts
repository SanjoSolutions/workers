import { $ } from "zx";

export interface GitBranchTarget {
  branch: string;
  hasRemote: boolean;
  remoteName?: string;
  remoteBranch?: string;
  upstreamRef?: string;
  displayName: string;
}

export async function getCurrentBranch(repoRoot: string): Promise<string> {
  const result =
    await $`git -C ${repoRoot} rev-parse --abbrev-ref HEAD`.quiet().nothrow();
  const branch = result.stdout.trim();
  if (result.exitCode !== 0 || !branch || branch === "HEAD") {
    throw new Error(`Cannot determine current branch for ${repoRoot}`);
  }
  return branch;
}

export async function resolveBranchTarget(
  repoRoot: string,
): Promise<GitBranchTarget> {
  const branch = await getCurrentBranch(repoRoot);
  const remoteResult =
    await $`git -C ${repoRoot} config --get branch.${branch}.remote`
      .quiet()
      .nothrow();
  const mergeResult =
    await $`git -C ${repoRoot} config --get branch.${branch}.merge`
      .quiet()
      .nothrow();

  const remoteName = remoteResult.stdout.trim();
  const mergeRef = mergeResult.stdout.trim();

  if (
    remoteResult.exitCode === 0
    && mergeResult.exitCode === 0
    && remoteName
    && remoteName !== "."
    && mergeRef.startsWith("refs/heads/")
  ) {
    const remoteBranch = mergeRef.replace(/^refs\/heads\//, "");
    return {
      branch,
      hasRemote: true,
      remoteName,
      remoteBranch,
      upstreamRef: `refs/remotes/${remoteName}/${remoteBranch}`,
      displayName: `${remoteName}/${remoteBranch}`,
    };
  }

  return {
    branch,
    hasRemote: false,
    displayName: branch,
  };
}

export async function requireRemoteBranchTarget(
  repoRoot: string,
): Promise<GitBranchTarget> {
  const target = await resolveBranchTarget(repoRoot);
  if (target.hasRemote) {
    return target;
  }

  throw new Error(
    `Workers requires the current branch "${target.branch}" to track a remote branch. Configure an upstream remote (for example a local bare repo) and try again.`,
  );
}

export async function fetchBranchTarget(
  repoRoot: string,
  target: GitBranchTarget,
): Promise<boolean> {
  if (!target.hasRemote || !target.remoteName) {
    return true;
  }

  const result =
    await $`git -C ${repoRoot} fetch ${target.remoteName}`.quiet().nothrow();
  return result.exitCode === 0;
}

export function targetRef(target: GitBranchTarget): string {
  return target.hasRemote && target.upstreamRef
    ? target.upstreamRef
    : target.branch;
}
