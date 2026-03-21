import { readFileSync } from "fs";
import path from "path";
import { describe, expect, test } from "vitest";
import { buildAssistantStartupPrompt } from "./assistant-startup-prompt.js";
import { prepareAssistantSystemPrompt } from "./assistant-system-prompt.js";

describe("assistant guidance", () => {
  test("uses the orchestrate CLI instead of repo-local helper scripts", () => {
    const prepared = prepareAssistantSystemPrompt(
      path.join(process.cwd(), "agents", "assistant", "SYSTEM.md"),
      "codex",
    );

    expect(prepared.content).toContain("o add --ready");
    expect(prepared.content).not.toContain("build/scripts/list-todos.js");
    expect(prepared.content).not.toContain("build/scripts/add-todo.js");
  });

  test("keeps startup branch checks in the initial assistant prompt", () => {
    const prepared = prepareAssistantSystemPrompt(
      path.join(process.cwd(), "agents", "assistant", "SYSTEM.md"),
      "codex",
    );

    expect(prepared.content).not.toContain(
      "At the start of every new conversation, before responding to the user's first message, run:",
    );
    expect(buildAssistantStartupPrompt()).toContain("o status --branches");
    expect(buildAssistantStartupPrompt()).toContain("finished branches");
  });

  test("does not suggest pull requests when the project disables them", () => {
    expect(buildAssistantStartupPrompt({ createPullRequest: false })).toContain(
      "Do not suggest opening a pull request",
    );
  });

  test("does not require a first-mention pull request question", () => {
    const content = readFileSync(
      path.join(process.cwd(), "agents", "assistant", "SYSTEM.md"),
      "utf8",
    );

    expect(content).not.toContain("ask the user whether workers should create pull requests");
  });
});
