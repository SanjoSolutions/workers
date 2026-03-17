import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import path from "path";
import { spawn } from "child_process";
import type { AgentStrategy, AgentResult } from "./types.js";
import { spawnAgentProcess } from "./process.js";
import { extractTodoField } from "../agent-prompt.js";
import { determinePackageRoot } from "../settings.js";

interface ManagedInteractiveGeminiSession {
  env: NodeJS.ProcessEnv;
  nextPrompt: string;
  statusFile: string;
  cleanup: () => void;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function workersGeminiInteractiveInstructions(): string {
  return `Workers session control:
- If you need the user to answer a question before you can continue, end your response with a final line that is exactly: WORKERS_STATUS: NEEDS_USER
- When the task is fully complete and workers should resume TODO sync and cleanup, end your response with a final line that is exactly: WORKERS_STATUS: DONE
- Do not emit either WORKERS_STATUS line for any other reason.`;
}

interface GeminiSettingsShape {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

function parseGeminiSettings(filePath: string, content: string): GeminiSettingsShape {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Failed to parse existing Gemini settings ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Invalid Gemini settings ${filePath}: expected a JSON object.`,
    );
  }

  return parsed as GeminiSettingsShape;
}

export function setupManagedInteractiveGeminiSession(
  worktreePath: string,
  claimedTodoItem: string,
  nextPrompt: string,
  env: NodeJS.ProcessEnv,
): ManagedInteractiveGeminiSession {
  const controlDir = path.join(worktreePath, ".tmp", "workers-gemini-interactive");
  mkdirSync(controlDir, { recursive: true });

  const statusFile = path.join(controlDir, "status.json");
  writeFileSync(
    statusFile,
    `${JSON.stringify({ status: "running", source: "workers" })}\n`,
    "utf8",
  );

  const dotGeminiDir = path.join(worktreePath, ".gemini");
  mkdirSync(dotGeminiDir, { recursive: true });

  const settingsPath = path.join(dotGeminiDir, "settings.json");
  const originalSettingsJson = existsSync(settingsPath)
    ? readFileSync(settingsPath, "utf8")
    : null;

  const parsed = originalSettingsJson
    ? parseGeminiSettings(settingsPath, originalSettingsJson)
    : {};
  const hooks =
    parsed.hooks && typeof parsed.hooks === "object" && !Array.isArray(parsed.hooks)
      ? { ...parsed.hooks }
      : {};
  const afterAgentGroups = Array.isArray(hooks.AfterAgent) ? [...hooks.AfterAgent] : [];
  const hookScript = path.join(determinePackageRoot(), "src", "scripts", "gemini-after-agent-hook.mjs");

  afterAgentGroups.push({
    hooks: [
      {
        name: "workers-interactive-after-agent",
        type: "command",
        command: `${shellQuote(process.execPath)} ${shellQuote(hookScript)}`,
        timeout: 10000,
        description: "workers interactive after-agent hook",
      },
    ],
  });

  writeFileSync(
    settingsPath,
    `${JSON.stringify({ ...parsed, hooks: { ...hooks, AfterAgent: afterAgentGroups } }, null, 2)}\n`,
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
      WORKERS_GEMINI_STATUS_FILE: statusFile,
      WORKERS_TODO_SUMMARY: claimedSummary,
      WORKERS_LOCAL_TODO_PATH: localTodoPath,
    },
    nextPrompt: `${nextPrompt}\n\n${workersGeminiInteractiveInstructions()}`,
    statusFile,
    cleanup: () => {
      if (originalSettingsJson === null) {
        rmSync(settingsPath, { force: true });
      } else {
        writeFileSync(settingsPath, originalSettingsJson, "utf8");
      }
    },
  };
}

async function spawnManagedInteractiveGemini(
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
    let forcedKillTimer: NodeJS.Timeout | undefined;
    let lastStatusJson = "";

    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["inherit", "inherit", "inherit"],
    });

    const watchTimer = setInterval(() => {
      if (!existsSync(statusFile)) {
        return;
      }

      let rawStatus: string;
      try {
        rawStatus = readFileSync(statusFile, "utf8").trim();
      } catch {
        return;
      }

      if (!rawStatus || rawStatus === lastStatusJson) {
        return;
      }
      lastStatusJson = rawStatus;

      let statusParsed: unknown;
      try {
        statusParsed = JSON.parse(rawStatus);
      } catch {
        return;
      }

      const status =
        statusParsed && typeof statusParsed === "object" && "status" in statusParsed
          ? (statusParsed.status as string | undefined)
          : undefined;
      if (status !== "done" || stopRequested) {
        return;
      }

      managedDone = true;
      stopRequested = true;
      child.kill("SIGTERM");
      forcedKillTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 5000);
    }, 250);

    const finish = (result: AgentResult) => {
      clearInterval(watchTimer);
      if (forcedKillTimer) {
        clearTimeout(forcedKillTimer);
      }
      cleanup();
      resolve(result);
    };

    child.on("close", (code) => {
      finish({
        exitCode: managedDone ? 0 : code ?? 1,
        output: "",
      });
    });

    child.on("error", (error) => {
      finish({
        exitCode: 1,
        output: error.message,
      });
    });
  });
}

export class GeminiAgentStrategy implements AgentStrategy {
  readonly cli = "gemini" as const;

  async launch(context: Parameters<AgentStrategy["launch"]>[0]) {
    const geminiModel =
      extractTodoField(context.claimedTodoItem, "Model") ||
      context.options.model ||
      context.config?.agent?.model ||
      context.options.modelDefault;

    const args = [
      ...(geminiModel ? ["--model", geminiModel] : []),
      "--approval-mode",
      "auto_edit",
    ];

    if (context.noTodo) {
      return spawnAgentProcess({
        command: "gemini",
        args,
        cwd: context.worktreePath,
        env: context.env,
        captureOutput: false,
      });
    }

    if (context.options.interactive) {
      const managedSession = setupManagedInteractiveGeminiSession(
        context.worktreePath,
        context.claimedTodoItem,
        context.nextPrompt,
        context.env,
      );
      return spawnManagedInteractiveGemini(
        "gemini",
        args,
        context.worktreePath,
        managedSession.env,
        managedSession.statusFile,
        managedSession.cleanup,
      );
    }

    return spawnAgentProcess({
      command: "gemini",
      args: ["--prompt", context.nextPrompt, ...args],
      cwd: context.worktreePath,
      env: context.env,
      captureOutput: true,
    });
  }
}
