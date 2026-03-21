import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildAssistantStartupPrompt } from "../assistant-startup-prompt.js";
import { GeminiAgentStrategy } from "./gemini.js";
import { spawnAgentProcess } from "./process.js";
import { determinePackageRoot } from "../settings.js";

vi.mock("./process.js", () => ({
  spawnAgentProcess: vi.fn().mockResolvedValue({ exitCode: 0, output: "" }),
}));

vi.mock("./managed-interactive.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    spawnManagedInteractiveAgent: vi.fn().mockResolvedValue({ exitCode: 0, output: "" }),
  };
});

describe("GeminiAgentStrategy", () => {
  const strategy = new GeminiAgentStrategy();
  const packageRoot = determinePackageRoot();
  const worktreePath = "/worktree";
  const baseContext = {
    worktreePath,
    claimedTodoItem: "- Build feature",
    nextPrompt: "Implement it",
    env: { ORIGINAL_ENV: "true" },
    options: {
      model: "gemini-pro",
      interactive: false,
      modelDefault: "gemini-1.5-pro",
    },
    noTodo: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("sets GEMINI_SYSTEM_MD for non-interactive worker", async () => {
    await strategy.launch(baseContext as any);

    const call = vi.mocked(spawnAgentProcess).mock.calls[0]?.[0];
    const renderedPromptPath = call?.env.GEMINI_SYSTEM_MD as string;
    expect(spawnAgentProcess).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({
        GEMINI_SYSTEM_MD: expect.any(String),
        ORIGINAL_ENV: "true",
      }),
    }));
    expect(renderedPromptPath).toContain("workers-system-prompt-cache");
  });

  test("sets GEMINI_SYSTEM_MD for noTodo (assistant)", async () => {
    await strategy.launch({
      ...baseContext,
      noTodo: true,
      nextPrompt: buildAssistantStartupPrompt(),
    } as any);

    const call = vi.mocked(spawnAgentProcess).mock.calls[0]?.[0];
    const renderedPromptPath = call?.env.GEMINI_SYSTEM_MD as string;
    expect(spawnAgentProcess).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({
        GEMINI_SYSTEM_MD: expect.any(String),
      }),
    }));
    expect(renderedPromptPath).not.toBe(path.join(packageRoot, "agents", "assistant", "SYSTEM.md"));
    expect(renderedPromptPath).toContain("workers-system-prompt-cache");
    expect(readFileSync(renderedPromptPath, "utf8")).toContain("`write_todos`");
    expect(readFileSync(renderedPromptPath, "utf8")).toContain("Do not rely on plan mode.");
    expect(call?.args).toContain(buildAssistantStartupPrompt());
  });

  test("sets GEMINI_SYSTEM_MD for interactive worker", async () => {
    const { spawnManagedInteractiveAgent } = await import("./managed-interactive.js");

    const worktree = mkdtempSync(path.join(tmpdir(), "workers-gemini-test-"));
    mkdirSync(path.join(worktree, ".gemini"), { recursive: true });
    writeFileSync(path.join(worktree, "TODO.md"), "## In progress\n\n- Build feature\n", "utf8");

    await strategy.launch({
      ...baseContext,
      worktreePath: worktree,
      options: { ...baseContext.options, interactive: true },
    } as any);

    expect(spawnManagedInteractiveAgent).toHaveBeenCalledWith(
      "gemini",
      expect.any(Array),
      worktree,
      expect.objectContaining({
        GEMINI_SYSTEM_MD: expect.stringContaining("workers-system-prompt-cache"),
        WORKERS_GEMINI_STATUS_FILE: expect.any(String),
        WORKERS_GEMINI_HOOK_SCRIPT: expect.any(String),
      }),
      expect.any(String),
      expect.any(Function),
    );
  });
});
