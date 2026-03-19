import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, describe, expect, test } from "vitest";
import {
  readInteractiveStatus,
  setupManagedInteractiveSession,
  spawnManagedInteractiveAgent,
  writeInteractiveStatus,
} from "./managed-interactive.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function createTempDir(prefix: string): string {
  const tempDir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

function createManagedSession(worktreePath: string) {
  mkdirSync(path.join(worktreePath, ".codex"), { recursive: true });
  writeFileSync(path.join(worktreePath, "TODO.md"), "## In progress\n\n- Build feature\n", "utf8");

  return setupManagedInteractiveSession(
    worktreePath,
    "- Build feature\n  - Repo: /tmp/example",
    "Implement the task",
    {},
    {
      controlDirName: "workers-codex-interactive",
      configDirName: ".codex",
      configFileName: "hooks.json",
      hookEventName: "Stop",
      hookScriptName: "codex-stop-hook.mjs",
      hookEntry: (command) => ({
        type: "command",
        command,
      }),
      statusEnvVar: "WORKERS_CODEX_STATUS_FILE",
    },
  );
}

describe("managed interactive status", () => {
  test("writes running status metadata when a managed session is created", () => {
    const worktreePath = createTempDir("workers-managed-session-");
    const session = createManagedSession(worktreePath);

    const status = JSON.parse(readFileSync(session.statusFile, "utf8")) as {
      status: string;
      source: string;
      launcherPid: number;
      startedAt: string;
      updatedAt: string;
    };

    expect(status.status).toBe("running");
    expect(status.source).toBe("workers");
    expect(status.launcherPid).toBe(process.pid);
    expect(status.startedAt).toEqual(expect.any(String));
    expect(status.updatedAt).toEqual(expect.any(String));

    session.cleanup();
  });

  test("marks a dead running session as stale when read", () => {
    const worktreePath = createTempDir("workers-managed-stale-");
    const statusFile = path.join(worktreePath, "status.json");

    writeInteractiveStatus(statusFile, {
      status: "running",
      source: "workers",
      launcherPid: 999999,
    });

    const status = readInteractiveStatus(statusFile);

    expect(status?.status).toBe("stale");
    expect(JSON.parse(readFileSync(statusFile, "utf8")).status).toBe("stale");
  });

  test("records a stopped status when the child exits cleanly without done", async () => {
    const worktreePath = createTempDir("workers-managed-stop-");
    const statusFile = path.join(worktreePath, "status.json");

    writeInteractiveStatus(statusFile, {
      status: "running",
      source: "workers",
      launcherPid: process.pid,
    });

    const result = await spawnManagedInteractiveAgent(
      process.execPath,
      ["-e", "process.exit(0)"],
      worktreePath,
      process.env,
      statusFile,
      () => {},
    );

    expect(result.exitCode).toBe(0);

    const status = JSON.parse(readFileSync(statusFile, "utf8")) as {
      status: string;
      childPid: number;
      finishedAt: string;
    };
    expect(status.status).toBe("stopped");
    expect(status.childPid).toBeGreaterThan(0);
    expect(status.finishedAt).toEqual(expect.any(String));
  });

  test("records an error status when the child exits with a non-zero code", async () => {
    const worktreePath = createTempDir("workers-managed-error-");
    const statusFile = path.join(worktreePath, "status.json");

    writeInteractiveStatus(statusFile, {
      status: "running",
      source: "workers",
      launcherPid: process.pid,
    });

    const result = await spawnManagedInteractiveAgent(
      process.execPath,
      ["-e", "process.exit(7)"],
      worktreePath,
      process.env,
      statusFile,
      () => {},
    );

    expect(result.exitCode).toBe(7);
    expect(JSON.parse(readFileSync(statusFile, "utf8")).status).toBe("error");
  });

  test("records an interrupted status when the worker process receives SIGINT", async () => {
    const worktreePath = createTempDir("workers-managed-interrupt-");
    const statusFile = path.join(worktreePath, "status.json");

    writeInteractiveStatus(statusFile, {
      status: "running",
      source: "workers",
      launcherPid: process.pid,
    });

    const resultPromise = spawnManagedInteractiveAgent(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      worktreePath,
      process.env,
      statusFile,
      () => {},
    );

    setTimeout(() => {
      process.emit("SIGINT");
    }, 50);

    const result = await resultPromise;

    expect(result.exitCode).toBe(130);

    const status = JSON.parse(readFileSync(statusFile, "utf8")) as {
      status: string;
      signal: string;
    };
    expect(status.status).toBe("interrupted");
    expect(status.signal).toBe("SIGINT");
  });
});
