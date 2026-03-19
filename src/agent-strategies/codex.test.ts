import { describe, expect, test, vi, beforeEach } from "vitest";
import path from "path";
import { CodexAgentStrategy } from "./codex.js";
import { spawnAgentProcess } from "./process.js";
import { spawnManagedInteractiveAgent } from "./managed-interactive.js";
import { setupManagedInteractiveCodexSession } from "./codex/interactive.js";
import { evaluateCodexSelection } from "../model-selection.js";

vi.mock("./process.js", () => ({
  spawnAgentProcess: vi.fn().mockResolvedValue({ exitCode: 0, output: "" }),
}));

vi.mock("./managed-interactive.js", () => ({
  spawnManagedInteractiveAgent: vi.fn().mockResolvedValue({ exitCode: 0, output: "" }),
}));

vi.mock("./codex/interactive.js", () => ({
  setupManagedInteractiveCodexSession: vi.fn().mockReturnValue({
    env: { MANAGED_ENV: "true" },
    nextPrompt: "Implement it\n\nWorkers session control...",
    statusFile: "/tmp/codex-status.json",
    cleanup: vi.fn(),
  }),
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
    const promptArg = call?.args.find((arg) => arg.startsWith("model_instructions_file="));
    const renderedPromptPath = promptArg
      ? JSON.parse(promptArg.slice("model_instructions_file=".length))
      : "";
    expect(renderedPromptPath).toContain("workers-system-prompt-cache");
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
    const promptArg = call?.args.find((arg) => arg.startsWith("model_instructions_file="));
    const renderedPromptPath = promptArg
      ? JSON.parse(promptArg.slice("model_instructions_file=".length))
      : "";
    expect(call?.args).toContainEqual(expect.stringContaining("model_instructions_file="));
    expect(renderedPromptPath).toBeTruthy();
    expect(renderedPromptPath).not.toBe(path.join("agents", "assistant", "SYSTEM.md"));
    expect(renderedPromptPath).toContain("workers-system-prompt-cache");
    expect(call?.args).not.toContain("");
    expect(call?.env.GH_TOKEN).toBe("shared-token");
  });

  test("passes the rendered worker system prompt in worker mode", async () => {
    await strategy.launch({
      ...baseContext,
    } as any);

    const call = vi.mocked(spawnAgentProcess).mock.calls[0]?.[0];
    const promptArg = call?.args.find((arg) => arg.startsWith("model_instructions_file="));
    const renderedPromptPath = promptArg
      ? JSON.parse(promptArg.slice("model_instructions_file=".length))
      : "";
    expect(renderedPromptPath).toContain("workers-system-prompt-cache");
  });

  test("passes only the managed interactive prompt to Codex interactive mode", async () => {
    await strategy.launch({
      ...baseContext,
      options: {
        ...baseContext.options,
        interactive: true,
      },
    } as any);

    expect(setupManagedInteractiveCodexSession).toHaveBeenCalledWith(
      "/worktree",
      "- Build feature",
      "Implement it",
      expect.objectContaining({ ORIGINAL_ENV: "true" }),
    );

    const call = vi.mocked(spawnManagedInteractiveAgent).mock.calls[0];
    expect(call?.[0]).toBe("codex");
    expect(call?.[1]).toEqual(expect.arrayContaining([
      "--enable",
      "codex_hooks",
      "--model",
      "gpt-5.4-mini",
      "Implement it\n\nWorkers session control...",
    ]));
    expect(call?.[1]).not.toContain("Implement it");
  });
});
