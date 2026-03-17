import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import path from "path";
import { spawn } from "child_process";
import { extractTodoField } from "../agent-prompt.js";
import { determinePackageRoot } from "../settings.js";
import type { AgentStrategy, AgentResult } from "./types.js";
import { spawnAgentProcess } from "./process.js";

interface HookFileShape {
  hooks?: Record<string, unknown>;
}

interface ManagedInteractiveCodexSession {
  env: NodeJS.ProcessEnv;
  nextPrompt: string;
  statusFile: string;
  cleanup: () => void;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function workersCodexInteractiveInstructions(): string {
  return `Workers session control:
- If you need the user to answer a question before you can continue, end your response with a final line that is exactly: WORKERS_STATUS: NEEDS_USER
- When the task is fully complete and workers should resume TODO sync and cleanup, end your response with a final line that is exactly: WORKERS_STATUS: DONE
- Do not emit either WORKERS_STATUS line for any other reason.`;
}

function parseHookFile(filePath: string, content: string): HookFileShape {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Failed to parse existing Codex hooks config ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Invalid Codex hooks config ${filePath}: expected a JSON object.`,
    );
  }

  return parsed as HookFileShape;
}

export function setupManagedInteractiveCodexSession(
  worktreePath: string,
  claimedTodoItem: string,
  nextPrompt: string,
  env: NodeJS.ProcessEnv,
): ManagedInteractiveCodexSession {
  const controlDir = path.join(worktreePath, ".tmp", "workers-codex-interactive");
  mkdirSync(controlDir, { recursive: true });

  const statusFile = path.join(controlDir, "status.json");
  writeFileSync(
    statusFile,
    `${JSON.stringify({ status: "running", source: "workers" })}\n`,
    "utf8",
  );

  const dotCodexDir = path.join(worktreePath, ".codex");
  mkdirSync(dotCodexDir, { recursive: true });

  const hooksPath = path.join(dotCodexDir, "hooks.json");
  const originalHooksJson = existsSync(hooksPath)
    ? readFileSync(hooksPath, "utf8")
    : null;

  const parsed = originalHooksJson
    ? parseHookFile(hooksPath, originalHooksJson)
    : {};
  const hooks =
    parsed.hooks && typeof parsed.hooks === "object" && !Array.isArray(parsed.hooks)
      ? { ...parsed.hooks }
      : {};
  const stopGroups = Array.isArray(hooks.Stop) ? [...hooks.Stop] : [];
  const hookScript = path.join(determinePackageRoot(), "src", "scripts", "codex-stop-hook.mjs");

  stopGroups.push({
    hooks: [
      {
        type: "command",
        command: `${shellQuote(process.execPath)} ${shellQuote(hookScript)}`,
        timeoutSec: 10,
        statusMessage: "workers interactive stop hook",
      },
    ],
  });

  writeFileSync(
    hooksPath,
    `${JSON.stringify({ ...parsed, hooks: { ...hooks, Stop: stopGroups } }, null, 2)}\n`,
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
      WORKERS_CODEX_STATUS_FILE: statusFile,
      WORKERS_TODO_SUMMARY: claimedSummary,
      WORKERS_LOCAL_TODO_PATH: localTodoPath,
    },
    nextPrompt: `${nextPrompt}\n\n${workersCodexInteractiveInstructions()}`,
    statusFile,
    cleanup: () => {
      if (originalHooksJson === null) {
        rmSync(hooksPath, { force: true });
      } else {
        writeFileSync(hooksPath, originalHooksJson, "utf8");
      }
    },
  };
}

async function spawnManagedInteractiveCodex(
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

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawStatus);
      } catch {
        return;
      }

      const status =
        parsed && typeof parsed === "object" && "status" in parsed
          ? (parsed.status as string | undefined)
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

export class CodexAgentStrategy implements AgentStrategy {
  readonly cli = "codex" as const;

  async launch(context: Parameters<AgentStrategy["launch"]>[0]) {
    const codexModel =
      extractTodoField(context.claimedTodoItem, "Model") ||
      context.options.model ||
      context.config?.agent?.model ||
      context.options.modelDefault;
    const reasoningEffort =
      extractTodoField(context.claimedTodoItem, "Reasoning") ||
      context.options.reasoningEffort ||
      context.config?.agent?.codexDefaultReasoning ||
      "high";

    const codexArgs = [
      ...(codexModel ? ["--model", codexModel] : []),
      "--config",
      `model_reasoning_effort=${reasoningEffort}`,
    ];
    for (const dir of context.config?.agent?.codexWritableDirs ?? []) {
      codexArgs.push("--add-dir", dir);
    }
    codexArgs.push(
      "--config",
      "sandbox_workspace_write.network_access=true",
    );

    if (context.noTodo) {
      return spawnAgentProcess({
        command: "codex",
        args: codexArgs,
        cwd: context.worktreePath,
        env: context.env,
        captureOutput: false,
      });
    }

    if (context.options.interactive) {
      const managedSession = setupManagedInteractiveCodexSession(
        context.worktreePath,
        context.claimedTodoItem,
        context.nextPrompt,
        context.env,
      );
      return spawnManagedInteractiveCodex(
        "codex",
        ["--enable", "codex_hooks", ...codexArgs, managedSession.nextPrompt],
        context.worktreePath,
        managedSession.env,
        managedSession.statusFile,
        managedSession.cleanup,
      );
    }

    return spawnAgentProcess({
      command: "codex",
      args: [
        "exec",
        "--full-auto",
        "--config",
        "approval_policy=never",
        ...codexArgs,
        context.nextPrompt,
      ],
      cwd: context.worktreePath,
      env: context.env,
      captureOutput: true,
    });
  }
}
