import { $ } from "zx";

export async function resolveGitRepoRoot(startPath: string): Promise<string> {
  const result =
    await $`git -C ${startPath} rev-parse --show-toplevel`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`Cannot find git repository for ${startPath}`);
  }
  return result.stdout.trim();
}

export async function findGitRepoRoot(startPath: string): Promise<string | null> {
  const result =
    await $`git -C ${startPath} rev-parse --show-toplevel`.quiet().nothrow();
  if (result.exitCode !== 0) {
    return null;
  }
  const repoRoot = result.stdout.trim();
  return repoRoot || null;
}
