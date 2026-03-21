import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import path from "path";
import { spawn } from "child_process";
import { determinePackageRoot } from "../settings.js";
import { shouldUseWindowsCommandShell } from "./process.js";
import type { AgentResult } from "./types.js";
import {
  determineTerminalInteractiveStatus,
  isInteractiveStatusStale,
  normalizeInteractiveStatus,
  readInteractiveStatus,
  writeInteractiveStatus,
} from "./interactive-status.js";

export {
  determineTerminalInteractiveStatus,
  isInteractiveStatusStale,
  normalizeInteractiveStatus,
  readInteractiveStatus,
  writeInteractiveStatus,
};

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function workersInteractiveInstructions(): string {
  return `Workers session control:
- If you need the user to answer a question before you can continue, end your response with a final line that is exactly: WORKERS_STATUS: NEEDS_USER
- When the task is fully complete and workers should resume TODO sync and cleanup, end your response with a final line that is exactly: WORKERS_STATUS: DONE
- Do not emit either WORKERS_STATUS line for any other reason.`;
}

interface HookConfigShape {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

export function parseJsonConfig(filePath: string, content: string): HookConfigShape {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Invalid config ${filePath}: expected a JSON object.`,
    );
  }

  return parsed as HookConfigShape;
}

export interface ManagedInteractiveSession {
  env: NodeJS.ProcessEnv;
  nextPrompt: string;
  statusFile: string;
  cleanup: () => void;
}

export interface ManagedSessionConfig {
  controlDirName: string;
  configDirName: string;
  configFileName: string;
  hookEventName: string;
  hookScriptName: string;
  hookEntry: (command: string) => Record<string, unknown>;
  statusEnvVar: string;
}

export function setupManagedInteractiveSession(
  worktreePath: string,
  claimedTodoItem: string,
  nextPrompt: string,
  env: NodeJS.ProcessEnv,
  config: ManagedSessionConfig,
): ManagedInteractiveSession {
  const controlDir = path.join(worktreePath, ".tmp", config.controlDirName);
  mkdirSync(controlDir, { recursive: true });

  const statusFile = path.join(controlDir, "status.json");
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

  const configDir = path.join(worktreePath, config.configDirName);
  mkdirSync(configDir, { recursive: true });

  const configPath = path.join(configDir, config.configFileName);
  const originalConfigJson = existsSync(configPath)
    ? readFileSync(configPath, "utf8")
    : null;

  const parsed = originalConfigJson
    ? parseJsonConfig(configPath, originalConfigJson)
    : {};
  const hooks =
    parsed.hooks && typeof parsed.hooks === "object" && !Array.isArray(parsed.hooks)
      ? { ...parsed.hooks }
      : {};
  const hookGroups = Array.isArray(hooks[config.hookEventName])
    ? [...(hooks[config.hookEventName] as unknown[])]
    : [];
  const hookScript = path.join(determinePackageRoot(), "src", "scripts", config.hookScriptName);
  const command = `${shellQuote(process.execPath)} ${shellQuote(hookScript)}`;

  hookGroups.push({
    hooks: [config.hookEntry(command)],
  });

  writeFileSync(
    configPath,
    `${JSON.stringify({ ...parsed, hooks: { ...hooks, [config.hookEventName]: hookGroups } }, null, 2)}\n`,
    "utf8",
  );

  const claimedSummary = claimedTodoItem.split("\n")[0].replace(/^- /, "");
  const localTodoPath = path.resolve(
    worktreePath,
    process.env.WORKERS_LOCAL_TODO_PATH?.trim() || "TODO.md",
  );

  return {
    env: {
      ...env,
      [config.statusEnvVar]: statusFile,
      WORKERS_TODO_SUMMARY: claimedSummary,
      WORKERS_LOCAL_TODO_PATH: localTodoPath,
    },
    nextPrompt: `${nextPrompt}\n\n${workersInteractiveInstructions()}`,
    statusFile,
    cleanup: () => {
      if (originalConfigJson === null) {
        rmSync(configPath, { force: true });
      } else {
        writeFileSync(configPath, originalConfigJson, "utf8");
      }
    },
  };
}

export async function spawnManagedInteractiveAgent(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  statusFile: string,
  cleanup: () => void,
): Promise<AgentResult> {
  return new Promise<AgentResult>((resolve) => {
    let managedDone = false;
    let stopRequested = false;
    let interruptedBySignal: NodeJS.Signals | undefined;
    let forcedKillTimer: NodeJS.Timeout | undefined;
    let lastStatusJson = "";

    const child = spawn(command, args, {
      cwd,
      env,
      shell: shouldUseWindowsCommandShell(command),
      stdio: ["inherit", "inherit", "inherit"],
    });

    if (typeof child.pid === "number") {
      writeInteractiveStatus(statusFile, {
        status: "running",
        source: "workers",
        childPid: child.pid,
      });
    }

    normalizeInteractiveStatus(statusFile);

    const watchTimer = setInterval(() => {
      const status = readInteractiveStatus(statusFile);
      if (!status) {
        return;
      }

      const rawStatus = JSON.stringify(status);
      if (rawStatus === lastStatusJson) {
        return;
      }
      lastStatusJson = rawStatus;

      if (status.status !== "done" || stopRequested) {
        return;
      }

      managedDone = true;
      stopRequested = true;
      child.kill("SIGTERM");
      forcedKillTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 5000);
    }, 250);

    const signalHandlers = new Map<string, () => void>();
    const installSignalHandler = (signal: NodeJS.Signals) => {
      const handler = () => {
        if (stopRequested || managedDone) {
          return;
        }

        interruptedBySignal = signal;
        stopRequested = true;
        writeInteractiveStatus(statusFile, {
          status: "interrupted",
          source: "workers",
          signal,
          finishedAt: new Date().toISOString(),
        });
        child.kill(signal);
        forcedKillTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 5000);
      };

      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    };

    installSignalHandler("SIGINT");
    installSignalHandler("SIGTERM");

    const finish = (result: AgentResult) => {
      clearInterval(watchTimer);
      if (forcedKillTimer) {
        clearTimeout(forcedKillTimer);
      }
      for (const [signal, handler] of signalHandlers) {
        process.off(signal, handler);
      }
      cleanup();
      resolve(result);
    };

    child.on("close", (code, signal) => {
      const currentStatus = normalizeInteractiveStatus(statusFile);
      const terminalStatus = determineTerminalInteractiveStatus(currentStatus, code, signal);
      if (terminalStatus) {
        writeInteractiveStatus(statusFile, terminalStatus);
      }
      finish({
        exitCode: managedDone ? 0 : interruptedBySignal ? 130 : code ?? 1,
        output: "",
      });
    });

    child.on("error", (error) => {
      const currentStatus = normalizeInteractiveStatus(statusFile);
      if (currentStatus && currentStatus.status !== "done" && currentStatus.status !== "needs_user") {
        writeInteractiveStatus(statusFile, {
          ...currentStatus,
          status: "error",
          error: error.message,
        });
      }
      finish({
        exitCode: 1,
        output: error.message,
      });
    });
  });
}
