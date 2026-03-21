import type { CliOptions, WorkConfig } from "./types.js";
import * as log from "./log.js";
import { buildAgentPrompt } from "./agent-prompt.js";
import { getAgentStrategy } from "./agent-strategies/index.js";
import type { AgentResult } from "./agent-strategies/types.js";
import { getCreatePullRequestSetting, loadSettings } from "./settings.js";
import { applyGitHubTokenFromSettings } from "./task-tracker-settings.js";

export async function launchAgent(
  options: CliOptions,
  worktreePath: string,
  claimedTodoItem: string,
  claimedTodoItemType: string,
  config?: WorkConfig,
  baseEnv: NodeJS.ProcessEnv = process.env,
  repoPathForSettings = worktreePath,
): Promise<AgentResult> {
  const settings = await loadSettings();
  await applyGitHubTokenFromSettings(settings);

  const noTodo = !claimedTodoItem;
  const workflowMode = options.interactive ? "interactive" : "non-interactive";

  const nextPrompt = noTodo
    ? ""
    : buildAgentPrompt(
        claimedTodoItem,
        claimedTodoItemType,
        config,
        {
          createPullRequest: getCreatePullRequestSetting(
            repoPathForSettings,
            settings.projects,
          ),
        },
      );

  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
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
