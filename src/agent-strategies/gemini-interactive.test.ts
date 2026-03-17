import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { spawnSync } from "child_process";
import { describe, expect, test } from "vitest";
import { setupManagedInteractiveGeminiSession } from "./gemini.js";

describe("gemini interactive workers hook", () => {
  test("injects and restores worktree settings for managed interactive sessions", () => {
    const worktreePath = mkdtempSync(path.join(tmpdir(), "workers-gemini-hook-"));
    const dotGeminiDir = path.join(worktreePath, ".gemini");
    const settingsPath = path.join(dotGeminiDir, "settings.json");
    mkdirSync(dotGeminiDir, { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            BeforeTool: [
              {
                hooks: [
                  {
                    name: "existing-hook",
                    type: "command",
                    command: "echo existing",
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    writeFileSync(
      path.join(worktreePath, "TODO.md"),
      "## In progress\n\n- Build feature\n",
      "utf8",
    );

    const session = setupManagedInteractiveGeminiSession(
      worktreePath,
      "- Build feature\n  - Repo: /tmp/example",
      "Implement the task",
      {},
    );

    expect(session.nextPrompt).toContain("WORKERS_STATUS: NEEDS_USER");
    expect(session.nextPrompt).toContain("WORKERS_STATUS: DONE");

    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks: Record<string, unknown[]>;
    };
    expect(settings.hooks.BeforeTool).toHaveLength(1);
    expect(Array.isArray(settings.hooks.AfterAgent)).toBe(true);
    expect(settings.hooks.AfterAgent).toHaveLength(1);

    session.cleanup();

    const restored = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks: Record<string, unknown[]>;
    };
    expect(restored.hooks.AfterAgent).toBeUndefined();
    expect(restored.hooks.BeforeTool).toHaveLength(1);
  });

  test("after-agent hook records needs_user and done states", () => {
    const worktreePath = mkdtempSync(path.join(tmpdir(), "workers-gemini-stop-"));
    const statusFile = path.join(worktreePath, "status.json");
    const todoPath = path.join(worktreePath, "TODO.md");
    const hookScript = path.resolve("scripts/gemini-after-agent-hook.mjs");

    writeFileSync(todoPath, "## In progress\n\n- Build feature\n", "utf8");

    const needsUser = spawnSync(process.execPath, [hookScript], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        WORKERS_GEMINI_STATUS_FILE: statusFile,
        WORKERS_LOCAL_TODO_PATH: todoPath,
        WORKERS_TODO_SUMMARY: "Build feature",
      },
      input: JSON.stringify({
        last_assistant_message: "I need one decision.\nWORKERS_STATUS: NEEDS_USER",
      }),
      encoding: "utf8",
    });

    expect(needsUser.status).toBe(0);
    expect(JSON.parse(readFileSync(statusFile, "utf8")).status).toBe("needs_user");

    writeFileSync(todoPath, "## In progress\n\n", "utf8");
    const done = spawnSync(process.execPath, [hookScript], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        WORKERS_GEMINI_STATUS_FILE: statusFile,
        WORKERS_LOCAL_TODO_PATH: todoPath,
        WORKERS_TODO_SUMMARY: "Build feature",
      },
      input: JSON.stringify({
        last_assistant_message: "Implemented and committed.\nWORKERS_STATUS: DONE",
      }),
      encoding: "utf8",
    });

    expect(done.status).toBe(0);
    expect(JSON.parse(readFileSync(statusFile, "utf8")).status).toBe("done");
  });

  test("after-agent hook detects done via TODO removal", () => {
    const worktreePath = mkdtempSync(path.join(tmpdir(), "workers-gemini-todo-"));
    const statusFile = path.join(worktreePath, "status.json");
    const todoPath = path.join(worktreePath, "TODO.md");
    const hookScript = path.resolve("scripts/gemini-after-agent-hook.mjs");

    // TODO file no longer contains the claimed summary
    writeFileSync(todoPath, "## In progress\n\n", "utf8");

    const result = spawnSync(process.execPath, [hookScript], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        WORKERS_GEMINI_STATUS_FILE: statusFile,
        WORKERS_LOCAL_TODO_PATH: todoPath,
        WORKERS_TODO_SUMMARY: "Build feature",
      },
      input: JSON.stringify({
        last_assistant_message: "All done, committed everything.",
      }),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(statusFile, "utf8")).status).toBe("done");
  });
});
