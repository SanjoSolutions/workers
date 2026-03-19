import { describe, expect, test, vi, beforeEach } from "vitest";
import path from "path";
import { CodexAgentStrategy } from "./codex.js";
import { spawnAgentProcess } from "./process.js";
import { evaluateCodexSelection } from "../model-selection.js";

vi.mock("./process.js", () => ({
  spawnAgentProcess: vi.fn().mockResolvedValue({ exitCode: 0, output: "" }),
}));

vi.mock("../model-selection.js", () => ({
  evaluateCodexSelection: vi.fn().mockResolvedValue({
    model: "gpt-5.4-mini",
    reasoningEffort: "medium",
  }),
}));

describe("CodexAgentStrategy", () => {
  const strategy = new CodexAgentStrategy();
  const baseContext = {
    worktreePath: "/worktree",
    claimedTodoItem: "- Build feature",
    claimedTodoItemType: "feature",
    nextPrompt: "Implement it",
    workflowMode: "non-interactive",
    env: { ORIGINAL_ENV: "true", GH_TOKEN: "shared-token" },
    options: {
      interactive: false,
      modelDefault: "gpt-5.4",
      autoModelSelection: true,
      autoModelSelectionModels: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"],
      autoReasoningEffort: true,
      codexSystemPromptVariant: "full",
    },
    noTodo: false,
    config: undefined,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("auto-selects Codex model and reasoning effort from worker settings", async () => {
    await strategy.launch(baseContext as any);

    expect(evaluateCodexSelection).toHaveBeenCalledWith(
      "- Build feature",
      expect.objectContaining({
        candidateModels: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"],
        fallbackModel: "gpt-5.4",
        fallbackReasoningEffort: "high",
      }),
    );

    expect(spawnAgentProcess).toHaveBeenCalledWith(expect.objectContaining({
      command: "codex",
      args: expect.arrayContaining([
        "exec",
        "--model",
        "gpt-5.4-mini",
        "--config",
        "model_reasoning_effort=medium",
      ]),
      env: expect.objectContaining({
        ORIGINAL_ENV: "true",
        GH_TOKEN: "shared-token",
      }),
    }));

    const call = vi.mocked(spawnAgentProcess).mock.calls[0]?.[0];
    expect(call?.args).toContain("Implement it");
    expect(call?.args).toContainEqual(expect.stringContaining("model_instructions_file="));
    expect(call?.args).toContainEqual(expect.stringContaining("SYSTEM.md"));
  });

  test("skips auto-selection when explicit model and reasoning effort are provided", async () => {
    await strategy.launch({
      ...baseContext,
      claimedTodoItem: "- Build feature\n  - Model: gpt-5.3-codex\n  - Reasoning: low",
    } as any);

    expect(evaluateCodexSelection).not.toHaveBeenCalled();
    expect(spawnAgentProcess).toHaveBeenCalledWith(expect.objectContaining({
      args: expect.arrayContaining([
        "--model",
        "gpt-5.3-codex",
        "--config",
        "model_reasoning_effort=low",
      ]),
    }));
  });

  test("passes the assistant system prompt in no-todo mode", async () => {
    await strategy.launch({
      ...baseContext,
      noTodo: true,
      claimedTodoItem: "",
      claimedTodoItemType: "",
      nextPrompt: "",
      env: {
        ...baseContext.env,
        GH_TOKEN: "shared-token",
      },
    } as any);

    const call = vi.mocked(spawnAgentProcess).mock.calls[0]?.[0];
    expect(call?.args).toContainEqual(expect.stringContaining("model_instructions_file="));
    expect(call?.args).toContainEqual(expect.stringContaining(path.join("agents", "assistant", "SYSTEM.md")));
    expect(call?.args).not.toContain("");
    expect(call?.env.GH_TOKEN).toBe("shared-token");
  });

  test("uses the minimal worker system prompt variant when configured", async () => {
    await strategy.launch({
      ...baseContext,
      options: {
        ...baseContext.options,
        codexSystemPromptVariant: "minimal",
      },
    } as any);

    const call = vi.mocked(spawnAgentProcess).mock.calls[0]?.[0];
    expect(call?.args).toContainEqual(expect.stringContaining("SYSTEM_MINIMAL.md"));
  });
});
