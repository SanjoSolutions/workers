import type { CliOptions, WorkConfig } from "./types.js";
import * as log from "./log.js";
import { buildAgentPrompt } from "./agent-prompt.js";
import { getAgentStrategy } from "./agent-strategies/index.js";
import type { AgentResult } from "./agent-strategies/types.js";

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
    : buildAgentPrompt(
        claimedTodoItem,
        claimedTodoItemType,
        config,
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

  const strategy = getAgentStrategy(options.cli);

  try {
    return await strategy.launch({
      options,
      worktreePath,
      claimedTodoItem,
      claimedTodoItemType,
      config,
      nextPrompt,
      workflowMode,
      noTodo,
      env,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`Failed to launch ${options.cli}: ${message}`);
    return {
      exitCode: 1,
      output: message,
    };
  }
}
