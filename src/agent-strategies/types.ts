import type { CliName, CliOptions, WorkConfig } from "../types.js";

export interface AgentResult {
  exitCode: number;
  output: string;
}

export interface AgentLaunchContext {
  options: CliOptions;
  worktreePath: string;
  claimedTodoItem: string;
  claimedTodoItemType: string;
  config?: WorkConfig;
  nextPrompt: string;
  workflowMode: string;
  noTodo: boolean;
  env: NodeJS.ProcessEnv;
}

export interface AgentStrategy {
  readonly cli: CliName;
  launch(context: AgentLaunchContext): Promise<AgentResult>;
}
