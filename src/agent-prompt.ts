import type { WorkConfig } from "./types.js";

interface AgentPromptOptions {
  createPullRequest?: boolean;
}

export function extractTodoField(item: string, field: string): string {
  const match = item.match(new RegExp(`^\\s+- ${field}:\\s*(.+)$`, "im"));
  return match ? match[1].trim() : "";
}

function defaultPrompt(
  todo: string,
  todoType: string,
  options: AgentPromptOptions = {},
): string {
  const pullRequestInstruction = options.createPullRequest === false
    ? `
6. This project has \`createPullRequest: false\`. Do not suggest opening a pull request unless the user explicitly asks for one.`
    : "";
  const taskSyncInstruction = `2. Remove the completed task entry from the local mirrored task file maintained by the workers runtime.
   Delete the entire item, including all indented sub-items. Do not leave it in place or mark it as done.
3. Commit your implementation changes on the worker branch for this repo. If this task bootstraps
   a new project, the workers runtime may already have created the target repo and worktree for you;
   continue the implementation there unless the task explicitly says more bootstrap is needed.
4. Do NOT merge back to the tracked branch or push directly to main. The assistant lands finished
   worker branches later.
5. Do NOT add the local mirrored task file to the code-repo commit when it is untracked or ignored here.
   The workers runtime will sync task completion back to the configured task tracker after your work is done.${pullRequestInstruction}`;

  return `An item has been pre-claimed for you by the workers runtime.
Do NOT claim another item — work on this one.

Claimed item:
${todo}

Item type: ${todoType}

Instructions:
1. Implement the required changes for this task
${taskSyncInstruction}`;
}

function stripRuntimeMetadata(item: string): string {
  return item
    .split(/\r?\n/)
    .filter((line) => !/^\s+-\s*Repo:\s/i.test(line))
    .join("\n");
}

export function buildAgentPrompt(
  claimedTodoItem: string,
  claimedTodoItemType: string,
  config: WorkConfig | undefined,
  options: AgentPromptOptions = {},
): string {
  const cleanedItem = stripRuntimeMetadata(claimedTodoItem);
  return config?.agent?.buildPrompt
    ? config.agent.buildPrompt(cleanedItem, claimedTodoItemType)
    : defaultPrompt(cleanedItem, claimedTodoItemType, options);
}
