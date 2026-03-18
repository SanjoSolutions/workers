import { describe, expect, test, vi } from "vitest";
import path from "path";
import { GeminiAgentStrategy } from "./gemini.js";
import { spawnAgentProcess } from "./process.js";
import { setupManagedInteractiveSession } from "./managed-interactive.js";
import { determinePackageRoot } from "../settings.js";

vi.mock("./process.js", () => ({
  spawnAgentProcess: vi.fn().mockResolvedValue({ exitCode: 0, output: "" }),
}));

vi.mock("./managed-interactive.js", () => ({
  setupManagedInteractiveSession: vi.fn().mockReturnValue({
    env: { SESSION_ENV: "true" },
    nextPrompt: "next",
    statusFile: "status.json",
    cleanup: vi.fn(),
  }),
  spawnManagedInteractiveAgent: vi.fn().mockResolvedValue({ exitCode: 0, output: "" }),
  workersInteractiveInstructions: vi.fn().mockReturnValue("instructions"),
}));

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

  test("sets GEMINI_SYSTEM_MD for non-interactive worker", async () => {
    await strategy.launch(baseContext as any);
    
    expect(spawnAgentProcess).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({
        GEMINI_SYSTEM_MD: path.join(packageRoot, "agents", "worker", "SYSTEM.md"),
        ORIGINAL_ENV: "true",
      }),
    }));
  });

  test("sets GEMINI_SYSTEM_MD for noTodo (assistant)", async () => {
    await strategy.launch({ ...baseContext, noTodo: true } as any);
    
    expect(spawnAgentProcess).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({
        GEMINI_SYSTEM_MD: path.join(packageRoot, "agents", "assistant", "SYSTEM.md"),
      }),
    }));
  });

  test("sets GEMINI_SYSTEM_MD for interactive worker", async () => {
    await strategy.launch({
      ...baseContext,
      options: { ...baseContext.options, interactive: true },
    } as any);
    
    expect(setupManagedInteractiveSession).toHaveBeenCalledWith(
      worktreePath,
      baseContext.claimedTodoItem,
      baseContext.nextPrompt,
      expect.objectContaining({
        GEMINI_SYSTEM_MD: path.join(packageRoot, "agents", "worker", "SYSTEM.md"),
      }),
      expect.any(Object)
    );
  });
});
