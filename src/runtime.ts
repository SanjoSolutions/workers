import path from "path";
import { existsSync, symlinkSync } from "fs";
import type { CliName, RuntimeInfo } from "./types.js";
import { crcHash } from "./locking.js";

export function computeRuntimeInfo(
  repoRoot: string,
  cli: CliName,
  worktreePath: string,
): RuntimeInfo {
  const hash = crcHash(worktreePath);
  const portSlot = parseInt(hash, 10) % 1000;
  const id = `${cli}-${hash}`;
  const dir = path.join(repoRoot, ".git", "work-runtime", id);
  return { cli, hash, id, dir, portSlot };
}

/**
 * Symlink node_modules from repo root into worktree if not present.
 * Useful for Node.js projects since node_modules is gitignored.
 */
export function ensureWorktreeNodeModulesLink(
  worktreePath: string,
  repoRoot: string,
): void {
  const target = path.join(worktreePath, "node_modules");
  if (existsSync(target)) {
    return;
  }

  const source = path.join(repoRoot, "node_modules");
  if (existsSync(source)) {
    symlinkSync(source, target);
  }
}
