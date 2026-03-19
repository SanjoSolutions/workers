import { beforeEach, describe, expect, test, vi } from "vitest";
import { ClaudeAgentStrategy } from "./claude.js";
import { spawnAgentProcess } from "./process.js";

vi.mock("./process.js", () => ({
  spawnAgentProcess: vi.fn().mockResolvedValue({ exitCode: 0, output: "" }),
}));

vi.mock("../model-selection.js", () => ({
  evaluateClaudeModel: vi.fn().mockResolvedValue("sonnet"),
}));

describe("ClaudeAgentStrategy", () => {
  const strategy = new ClaudeAgentStrategy();
  const baseContext = {
    worktreePath: "/worktree",
    claimedTodoItem: "- Build feature",
    claimedTodoItemType: "feature",
    nextPrompt: "Implement it",
    workflowMode: "non-interactive",
    env: { ORIGINAL_ENV: "true", GH_TOKEN: "shared-token" },
    options: {
      interactive: false,
    },
    noTodo: false,
    config: undefined,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("passes shared GH_TOKEN through worker launches", async () => {
    await strategy.launch(baseContext as any);

    expect(spawnAgentProcess).toHaveBeenCalledWith(expect.objectContaining({
      command: "claude",
      env: expect.objectContaining({
        ORIGINAL_ENV: "true",
        GH_TOKEN: "shared-token",
      }),
    }));
  });

  test("passes shared GH_TOKEN through assistant launches", async () => {
    await strategy.launch({
      ...baseContext,
      noTodo: true,
      claimedTodoItem: "",
      claimedTodoItemType: "",
      nextPrompt: "",
    } as any);

    expect(spawnAgentProcess).toHaveBeenCalledWith(expect.objectContaining({
      command: "claude",
      env: expect.objectContaining({
        ORIGINAL_ENV: "true",
        GH_TOKEN: "shared-token",
      }),
    }));
  });
});
