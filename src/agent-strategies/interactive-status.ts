import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

export type InteractiveStatusName =
  | "running"
  | "continue"
  | "needs_user"
  | "done"
  | "stopped"
  | "interrupted"
  | "error"
  | "stale";

export interface InteractiveStatusRecord {
  status: InteractiveStatusName;
  source: "workers";
  launcherPid?: number;
  childPid?: number;
  startedAt?: string;
  updatedAt?: string;
  exitCode?: number;
  signal?: NodeJS.Signals;
  error?: string;
  [key: string]: unknown;
}

interface WriteInteractiveStatusOptions {
  mergeExisting?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EPERM"
    );
  }
}

export function readInteractiveStatus(statusFile: string): InteractiveStatusRecord | undefined {
  if (!existsSync(statusFile)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(readFileSync(statusFile, "utf8"));
    if (!isRecord(parsed) || typeof parsed.status !== "string") {
      return undefined;
    }

    return parsed as InteractiveStatusRecord;
  } catch {
    return undefined;
  }
}

export function isInteractiveStatusStale(status: InteractiveStatusRecord): boolean {
  if (status.status !== "running") {
    return false;
  }

  const launcherAlive =
    typeof status.launcherPid === "number" && isProcessAlive(status.launcherPid);
  const childAlive = typeof status.childPid === "number" && isProcessAlive(status.childPid);
  return !launcherAlive && !childAlive;
}

export function writeInteractiveStatus(
  statusFile: string,
  statusData: InteractiveStatusRecord,
  options: WriteInteractiveStatusOptions = {},
): void {
  mkdirSync(path.dirname(statusFile), { recursive: true });
  const existingStatus =
    options.mergeExisting === false ? undefined : readInteractiveStatus(statusFile);
  const mergedStatus = {
    ...(existingStatus ?? {}),
    ...statusData,
    updatedAt: new Date().toISOString(),
  };

  writeFileSync(statusFile, `${JSON.stringify(mergedStatus)}\n`, "utf8");
}

export function normalizeInteractiveStatus(
  statusFile: string,
): InteractiveStatusRecord | undefined {
  const status = readInteractiveStatus(statusFile);
  if (!status || !isInteractiveStatusStale(status)) {
    return status;
  }

  const staleStatus: InteractiveStatusRecord = {
    ...status,
    status: "stale",
  };
  writeInteractiveStatus(statusFile, staleStatus);
  return staleStatus;
}

export function determineTerminalInteractiveStatus(
  status: InteractiveStatusRecord | undefined,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): InteractiveStatusRecord | undefined {
  if (!status || status.status === "done" || status.status === "needs_user") {
    return undefined;
  }

  if (signal) {
    return {
      ...status,
      status: "interrupted",
      exitCode: exitCode ?? undefined,
      signal,
    };
  }

  if (exitCode === 0) {
    return {
      ...status,
      status: "stopped",
      exitCode,
    };
  }

  return {
    ...status,
    status: "error",
    exitCode: exitCode ?? undefined,
  };
}
