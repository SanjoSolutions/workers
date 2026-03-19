import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { describe, expect, test } from "vitest";
import {
  determineTerminalInteractiveStatus,
  normalizeInteractiveStatus,
  setupManagedInteractiveSession,
  spawnManagedInteractiveAgent,
  writeInteractiveStatus,
} from "./managed-interactive.js";

describe("managed interactive status", () => {
  test("writes session metadata for running status", () => {
    const worktreePath = mkdtempSync(path.join(tmpdir(), "workers-managed-interactive-"));
    const statusFile = path.join(worktreePath, ".tmp", "workers-test", "status.json");

    writeInteractiveStatus(
      statusFile,
      {
        status: "running",
        source: "workers",
        launcherPid: 12345,
        startedAt: "2026-03-19T00:00:00.000Z",
      },
      { mergeExisting: false },
    );

    const status = JSON.parse(readFileSync(statusFile, "utf8")) as {
      status: string;
      launcherPid: number;
      startedAt: string;
    };
    expect(status.status).toBe("running");
    expect(status.launcherPid).toBe(12345);
    expect(status.startedAt).toBe("2026-03-19T00:00:00.000Z");
  });

  test("marks dead running status files as stale", () => {
    const worktreePath = mkdtempSync(path.join(tmpdir(), "workers-managed-stale-"));
    const statusFile = path.join(worktreePath, "status.json");

    writeFileSync(
      statusFile,
      JSON.stringify({
        status: "running",
        source: "workers",
        launcherPid: 99999999,
        childPid: 99999998,
        startedAt: "2026-03-19T00:00:00.000Z",
      }) + "\n",
      "utf8",
    );

    const status = normalizeInteractiveStatus(statusFile);
    expect(status?.status).toBe("stale");
    expect(JSON.parse(readFileSync(statusFile, "utf8")).status).toBe("stale");
  });

  test("turns normal exit into stopped status", () => {
    const worktreePath = mkdtempSync(path.join(tmpdir(), "workers-managed-stop-"));
    const statusFile = path.join(worktreePath, "status.json");

    writeInteractiveStatus(
      statusFile,
      {
        status: "running",
        source: "workers",
        launcherPid: process.pid,
        childPid: 12345,
        startedAt: new Date().toISOString(),
      },
      { mergeExisting: false },
    );

    const terminalStatus = determineTerminalInteractiveStatus(
      {
        status: "continue",
        source: "workers",
        launcherPid: process.pid,
        childPid: 12345,
        startedAt: new Date().toISOString(),
      },
      0,
      null,
    );

    expect(terminalStatus?.status).toBe("stopped");
  });
});

describe("spawnManagedInteractiveAgent", () => {
  test("writes stopped status on normal exit", async () => {
    const worktreePath = mkdtempSync(path.join(tmpdir(), "workers-managed-exit-"));
    const statusFile = path.join(worktreePath, "status.json");
    writeInteractiveStatus(
      statusFile,
      {
        status: "running",
        source: "workers",
        launcherPid: process.pid,
        startedAt: new Date().toISOString(),
      },
      { mergeExisting: false },
    );

    const result = await spawnManagedInteractiveAgent(
      process.execPath,
      ["-e", "process.exit(0)"],
      worktreePath,
      {},
      statusFile,
      () => {},
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(statusFile, "utf8")).status).toBe("stopped");
  });

  test("writes error status on non-zero exit", async () => {
    const worktreePath = mkdtempSync(path.join(tmpdir(), "workers-managed-error-"));
    const statusFile = path.join(worktreePath, "status.json");
    writeInteractiveStatus(
      statusFile,
      {
        status: "running",
        source: "workers",
        launcherPid: process.pid,
        startedAt: new Date().toISOString(),
      },
      { mergeExisting: false },
    );

    await spawnManagedInteractiveAgent(
      process.execPath,
      ["-e", "process.exit(2)"],
      worktreePath,
      {},
      statusFile,
      () => {},
    );

    expect(JSON.parse(readFileSync(statusFile, "utf8")).status).toBe("error");
  });

  test("writes interrupted status on SIGTERM", async () => {
    const worktreePath = mkdtempSync(path.join(tmpdir(), "workers-managed-signal-"));
    const statusFile = path.join(worktreePath, "status.json");
    writeInteractiveStatus(
      statusFile,
      {
        status: "running",
        source: "workers",
        launcherPid: process.pid,
        startedAt: new Date().toISOString(),
      },
      { mergeExisting: false },
    );

    await spawnManagedInteractiveAgent(
      process.execPath,
      [
        "-e",
        "setTimeout(() => process.kill(process.pid, 'SIGTERM'), 10); setInterval(() => {}, 1000);",
      ],
      worktreePath,
      {},
      statusFile,
      () => {},
    );

    expect(JSON.parse(readFileSync(statusFile, "utf8")).status).toBe("interrupted");
  });
});

describe("setupManagedInteractiveSession", () => {
  test("creates running status with launcher metadata", () => {
    const worktreePath = mkdtempSync(path.join(tmpdir(), "workers-managed-setup-"));

    const session = setupManagedInteractiveSession(
      worktreePath,
      "- Build feature",
      "Implement it",
      {},
      {
        controlDirName: "workers-managed-setup",
        configDirName: ".example",
        configFileName: "settings.json",
        hookEventName: "Stop",
        hookScriptName: "noop.mjs",
        hookEntry: (command) => ({ type: "command", command }),
        statusEnvVar: "WORKERS_EXAMPLE_STATUS_FILE",
      },
    );

    const status = JSON.parse(readFileSync(session.statusFile, "utf8")) as {
      status: string;
      launcherPid: number;
      startedAt: string;
    };

    expect(status.status).toBe("running");
    expect(status.launcherPid).toBe(process.pid);
    expect(status.startedAt).toBeTruthy();
  });
});
