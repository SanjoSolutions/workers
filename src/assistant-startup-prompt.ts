export function buildAssistantStartupPrompt(): string {
  return [
    "Before replying to the first user message in this conversation, run `o status --branches`.",
    "If any finished branches are ready to merge, mention each branch and its completed task, then ask whether to merge them now.",
    "If there are no finished branches, continue normally.",
  ].join("\n");
}
