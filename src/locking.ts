import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import path from "path";
import { createHash } from "crypto";

/**
 * Compute a deterministic numeric hash for a path string.
 * Uses MD5 (truncated to 32-bit unsigned integer) as a pure Node.js
 * replacement for `printf '%s' ${value} | cksum`.
 */
export function crcHash(value: string): string {
  const md5 = createHash("md5").update(value).digest();
  const numeric = md5.readUInt32BE(0);
  return numeric.toString();
}

function lockDirForPath(lockRoot: string, lockHash: string): string {
  return path.join(lockRoot, `${lockHash}.lock`);
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function tryAcquireWorktreeLock(
  lockRoot: string,
  worktreePath: string,
): string | null {
  const lockHash = crcHash(worktreePath);
  const lockDir = lockDirForPath(lockRoot, lockHash);

  mkdirSync(lockRoot, { recursive: true });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      mkdirSync(lockDir);
      writeFileSync(path.join(lockDir, "pid"), `${process.pid}\n`);
      writeFileSync(path.join(lockDir, "path"), `${worktreePath}\n`);
      return lockDir;
    } catch {
      const pidFile = path.join(lockDir, "pid");
      let lockPid: number | null = null;
      try {
        const content = readFileSync(pidFile, "utf8").trim().split("\n")[0];
        lockPid = parseInt(content, 10);
      } catch {
        // Can't read PID file — try to remove stale lock
      }

      if (lockPid && isPidRunning(lockPid)) {
        return null;
      }

      try {
        rmSync(lockDir, { recursive: true, force: true });
      } catch {
        return null;
      }
    }
  }
}

export function releaseWorktreeLock(lockDir: string): void {
  if (!lockDir || !existsSync(lockDir)) {
    return;
  }

  const pidFile = path.join(lockDir, "pid");
  let lockPid: number | null = null;
  try {
    const content = readFileSync(pidFile, "utf8").trim().split("\n")[0];
    lockPid = parseInt(content, 10);
  } catch {
    // Can't read — remove anyway
  }

  if (!lockPid || lockPid === process.pid || !isPidRunning(lockPid)) {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

export function isWorktreeLockedByLiveProcess(
  lockRoot: string,
  worktreePath: string,
): boolean {
  const lockHash = crcHash(worktreePath);
  const lockDir = lockDirForPath(lockRoot, lockHash);

  if (!existsSync(lockDir)) {
    return false;
  }

  const pidFile = path.join(lockDir, "pid");
  let lockPid: number | null = null;
  try {
    const content = readFileSync(pidFile, "utf8").trim().split("\n")[0];
    lockPid = parseInt(content, 10);
  } catch {
    return false;
  }

  if (lockPid && isPidRunning(lockPid)) {
    if (lockPid === process.pid) {
      return false;
    }
    return true;
  }

  rmSync(lockDir, { recursive: true, force: true });
  return false;
}
