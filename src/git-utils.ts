import { runGit } from "./git-cli.js";

export async function resolveGitRepoRoot(startPath: string): Promise<string> {
  const result = await runGit(["-C", startPath, "rev-parse", "--show-toplevel"]);
  if (result.exitCode !== 0) {
    throw new Error(`Cannot find git repository for ${startPath}`);
  }
  return result.stdout.trim();
}

export async function findGitRepoRoot(startPath: string): Promise<string | null> {
  const result = await runGit(["-C", startPath, "rev-parse", "--show-toplevel"]);
  if (result.exitCode !== 0) {
    return null;
  }
  const repoRoot = result.stdout.trim();
  return repoRoot || null;
}
