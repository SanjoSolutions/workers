interface AssistantStartupPromptOptions {
  createPullRequest?: boolean;
}

export function buildAssistantStartupPrompt(
  options: AssistantStartupPromptOptions = {},
): string {
  const lines = [
    "Before replying to the first user message in this conversation, run `o status --branches`.",
    "If any finished branches are ready to merge, mention each branch and its completed task, then ask whether to merge them now.",
    "If there are no finished branches, continue normally.",
  ];

  if (options.createPullRequest === false) {
    lines.push(
      "This project has `createPullRequest: false`. Do not suggest opening a pull request unless the user explicitly asks for one.",
    );
  }

  return lines.join("\n");
}
