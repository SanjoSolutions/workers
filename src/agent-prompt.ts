import type { WorkConfig } from "./types.js";

export function extractTodoField(item: string, field: string): string {
  const match = item.match(new RegExp(`^\\s+- ${field}:\\s*(.+)$`, "im"));
  return match ? match[1].trim() : "";
}

function usesSharedTodoRepo(): boolean {
  return Boolean(process.env.WORKERS_TODO_REPO?.trim());
}

function defaultPrompt(
  todo: string,
  todoType: string,
  useSharedTodoRepo: boolean,
): string {
  const todoSyncInstruction = useSharedTodoRepo
    ? `2. Remove the completed TODO from TODO.md — delete the entire item (the "- " line and ALL
   indented sub-items) from "## In progress". Do NOT leave it or mark it as done — DELETE it.
3. Commit your implementation changes on the worker branch for this repo. If this TODO bootstraps
   a new project, the workers runtime may already have created the target repo and worktree for you;
   continue the implementation there unless the TODO explicitly says more bootstrap is needed.
4. Do NOT merge back to the tracked branch or push directly to main. The coordinator lands finished
   worker branches later.
5. Do NOT add TODO.md to the code-repo commit when it is untracked or ignored here.
   The workers runtime will sync TODO.md back to the shared TODO repo after your work is done.`
    : `2. Remove the completed TODO from TODO.md — delete the entire item (the "- " line and ALL
   indented sub-items) from "## In progress". Do NOT leave it or mark it as done — DELETE it.
3. Commit your implementation changes in the relevant repo. If this TODO bootstraps a new project,
   the runtime may already have created the target repo and worktree for you.
4. Do NOT merge or push to main automatically. The coordinator handles landing completed work.`;

  if (useSharedTodoRepo) {
    return `A TODO has been pre-claimed for you. It is already in the "## In progress" section of the local TODO.md copy.
Do NOT claim another TODO — work on this one.

Claimed TODO:
${todo}

TODO type: ${todoType}

Instructions:
1. Implement the required changes for this TODO
${todoSyncInstruction}`;
  }

  return `A TODO has been pre-claimed for you. It is already in the "## In progress" section of TODO.md.
Do NOT claim another TODO — work on this one.

Claimed TODO:
${todo}

TODO type: ${todoType}

Instructions:
1. Implement the required changes for this TODO
${todoSyncInstruction}`;
}

export function buildAgentPrompt(
  claimedTodoItem: string,
  claimedTodoItemType: string,
  config: WorkConfig | undefined,
): string {
  return config?.agent?.buildPrompt
    ? config.agent.buildPrompt(claimedTodoItem, claimedTodoItemType)
    : defaultPrompt(
        claimedTodoItem,
        claimedTodoItemType,
        usesSharedTodoRepo(),
      );
}
