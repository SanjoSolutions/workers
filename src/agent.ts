import { spawn } from "child_process";
import type { CliOptions, WorkConfig } from "./types.js";
import * as log from "./log.js";

interface AgentResult {
  exitCode: number;
  output: string;
}

export function extractTodoField(item: string, field: string): string {
  const match = item.match(new RegExp(`^\\s+- ${field}:\\s*(.+)$`, "im"));
  return match ? match[1].trim() : "";
}

function defaultPrompt(
  todo: string,
  todoType: string,
  useSharedTodoRepo: boolean,
): string {
  if (useSharedTodoRepo) {
    return `A TODO has been pre-claimed for you. It is already in the "## In progress" section of the local TODO.md copy.
Do NOT claim another TODO — work on this one.

Claimed TODO:
${todo}

TODO type: ${todoType}

Instructions:
1. Implement the required changes for this TODO
2. Remove the completed TODO from TODO.md — delete the entire item (the "- " line and ALL
   indented sub-items) from "## In progress". Do NOT leave it or mark it as done — DELETE it.
3. Commit and push the code changes in this repo.
4. Do NOT add TODO.md to the code-repo commit when it is untracked or ignored here.
   The workers runtime will sync TODO.md back to the shared TODO repo after your code push.`;
  }

  return `A TODO has been pre-claimed for you. It is already in the "## In progress" section of TODO.md.
Do NOT claim another TODO — work on this one.

Claimed TODO:
${todo}

TODO type: ${todoType}

Instructions:
1. Implement the required changes for this TODO
2. Remove the completed TODO from TODO.md — delete the entire item (the "- " line and ALL
   indented sub-items) from "## In progress". Do NOT leave it or mark it as done — DELETE it.
3. Commit your changes (include the updated TODO.md in the commit)
4. Push immediately: git push origin HEAD:main
   If push fails due to divergence: git pull --rebase origin main && git push origin HEAD:main
   NEVER use "git push origin HEAD" without ":main". NEVER skip the push.`;
}

const DEFAULT_CLAUDE_ALLOWED_TOOLS = [
  "Edit",
  "Bash",
  "Read",
  "Write",
  "Glob",
  "Grep",
  "Skill",
  "Task",
  "ToolSearch",
];

export async function launchAgent(
  options: CliOptions,
  worktreePath: string,
  claimedTodoItem: string,
  claimedTodoItemType: string,
  config?: WorkConfig,
): Promise<AgentResult> {
  const noTodo = !claimedTodoItem;
  const workflowMode = options.interactive ? "interactive" : "non-interactive";

  const nextPrompt = noTodo
    ? ""
    : config?.agent?.buildPrompt
      ? config.agent.buildPrompt(claimedTodoItem, claimedTodoItemType)
      : defaultPrompt(
          claimedTodoItem,
          claimedTodoItemType,
          Boolean(config?.todo?.sharedPath),
        );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORK_MODE: workflowMode,
    WORK_PRECLAIMED_TODO: claimedTodoItem,
    WORK_PRECLAIMED_TODO_TYPE: claimedTodoItemType,
  };

  // Add config-provided env vars
  if (config?.agent?.env) {
    const extraEnv = config.agent.env({
      mode: workflowMode,
      todo: claimedTodoItem,
      todoType: claimedTodoItemType,
    });
    Object.assign(env, extraEnv);
  }

  const claudeAllowedTools = (
    config?.agent?.claudeAllowedTools ?? DEFAULT_CLAUDE_ALLOWED_TOOLS
  ).join(",");

  return new Promise<AgentResult>((resolve) => {
    let args: string[];
    let command: string;
    let captureOutput: boolean;

    switch (options.cli) {
      case "claude": {
        command = "claude";
        const claudeModel =
          extractTodoField(claimedTodoItem, "Model") ||
          options.model ||
          config?.agent?.claudeDefaultModel ||
          "opus";
        if (noTodo) {
          args = [
            "--model",
            claudeModel,
            "--allowedTools",
            claudeAllowedTools,
          ];
          captureOutput = false;
        } else if (options.interactive) {
          args = [
            "--model",
            claudeModel,
            "--allowedTools",
            claudeAllowedTools,
            "--",
            nextPrompt,
          ];
          captureOutput = false;
        } else {
          args = [
            "--model",
            claudeModel,
            "-p",
            nextPrompt,
            "--dangerouslySkipPermissions",
            "--allowedTools",
            claudeAllowedTools,
          ];
          captureOutput = true;
        }
        break;
      }

      case "codex": {
        command = "codex";
        const codexModel =
          config?.agent?.codexModel || "o3";
        const reasoningEffort =
          extractTodoField(claimedTodoItem, "Reasoning") ||
          options.reasoningEffort ||
          config?.agent?.codexDefaultReasoning ||
          "high";
        const codexArgs = [
          "--model",
          codexModel,
          "--config",
          `model_reasoning_effort=${reasoningEffort}`,
        ];
        for (const dir of config?.agent?.codexWritableDirs ?? []) {
          codexArgs.push("--add-dir", dir);
        }
        if (options.isolatedRuntime) {
          codexArgs.push(
            "--config",
            "sandbox_workspace_write.network_access=true",
          );
        }
        if (noTodo) {
          args = [...codexArgs];
          captureOutput = false;
        } else if (options.interactive) {
          args = [...codexArgs, nextPrompt];
          captureOutput = false;
        } else {
          args = [
            "exec",
            "--full-auto",
            "--config",
            "approval_policy=never",
            ...codexArgs,
            nextPrompt,
          ];
          captureOutput = true;
        }
        break;
      }

      case "gemini":
        command = "gemini";
        if (noTodo) {
          args = ["--approval-mode", "auto_edit"];
        } else {
          args = [
            "--prompt",
            nextPrompt,
            "--approval-mode",
            "auto_edit",
          ];
        }
        captureOutput = !options.interactive;
        break;
    }

    let output = "";

    const child = spawn(command, args, {
      cwd: worktreePath,
      env,
      stdio: captureOutput
        ? ["inherit", "pipe", "pipe"]
        : ["inherit", "inherit", "inherit"],
    });

    if (captureOutput) {
      child.stdout?.on("data", (data: Buffer) => {
        output += data.toString();
      });
      child.stderr?.on("data", (data: Buffer) => {
        output += data.toString();
      });
    }

    child.on("close", (code) => {
      if (captureOutput && output) {
        console.log(output);
      }
      resolve({
        exitCode: code ?? 1,
        output,
      });
    });

    child.on("error", (err) => {
      log.error(`Failed to launch ${command}: ${err.message}`);
      resolve({
        exitCode: 1,
        output: err.message,
      });
    });
  });
}
