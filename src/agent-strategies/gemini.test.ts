import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { describe, expect, test, vi } from "vitest";
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
        GEMINI_SYSTEM_MD: path.join(packageRoot, "agents", "worker", "SYSTEM.md"),
        WORKERS_GEMINI_STATUS_FILE: expect.any(String),
        WORKERS_GEMINI_HOOK_SCRIPT: expect.any(String),
      }),
      expect.any(String),
      expect.any(Function),
    );
  });
});
