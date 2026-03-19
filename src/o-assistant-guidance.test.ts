import { readFileSync } from "fs";
import path from "path";
import { describe, expect, test } from "vitest";
import { prepareAssistantSystemPrompt } from "./assistant-system-prompt.js";

describe("assistant guidance", () => {
  test("uses the orchestrate CLI instead of repo-local helper scripts", () => {
    const prepared = prepareAssistantSystemPrompt(
      path.join(process.cwd(), "agents", "assistant", "SYSTEM.md"),
      "codex",
    );

    expect(prepared.content).toContain("o status --branches");
    expect(prepared.content).toContain("o add --ready");
    expect(prepared.content).not.toContain("build/scripts/list-todos.js");
    expect(prepared.content).not.toContain("build/scripts/add-todo.js");
  });

  test("does not require a first-mention pull request question", () => {
    const content = readFileSync(
      path.join(process.cwd(), "agents", "assistant", "SYSTEM.md"),
      "utf8",
    );

    expect(content).not.toContain("ask the user whether workers should create pull requests");
  });
});
