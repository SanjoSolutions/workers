import type { WorkConfig } from "./types.js";

export function extractTodoField(item: string, field: string): string {
  const match = item.match(new RegExp(`^\\s+- ${field}:\\s*(.+)$`, "im"));
  return match ? match[1].trim() : "";
}

function defaultPrompt(
  todo: string,
  todoType: string,
): string {
  const taskSyncInstruction = `2. Remove the completed task entry from the local mirrored task file maintained by the workers runtime.
   Delete the entire item, including all indented sub-items. Do not leave it in place or mark it as done.
3. Commit your implementation changes on the worker branch for this repo. If this task bootstraps
   a new project, the workers runtime may already have created the target repo and worktree for you;
   continue the implementation there unless the task explicitly says more bootstrap is needed.
4. Do NOT merge back to the tracked branch or push directly to main. The coordinator lands finished
   worker branches later.
5. Do NOT add the local mirrored task file to the code-repo commit when it is untracked or ignored here.
   The workers runtime will sync task completion back to the configured task tracker after your work is done.`;

  return `A task has been pre-claimed for you by the workers runtime.
Do NOT claim another task — work on this one.

Claimed task:
${todo}

Task type: ${todoType}

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
): string {
  const cleanedItem = stripRuntimeMetadata(claimedTodoItem);
  return config?.agent?.buildPrompt
    ? config.agent.buildPrompt(cleanedItem, claimedTodoItemType)
    : defaultPrompt(cleanedItem, claimedTodoItemType);
}
