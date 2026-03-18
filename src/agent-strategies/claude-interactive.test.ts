import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { spawnSync } from "child_process";
import { describe, expect, test } from "vitest";
import { setupManagedInteractiveClaudeSession } from "./claude.js";

describe("claude interactive workers hook", () => {
  test("injects and restores worktree hooks for managed interactive sessions", () => {
    const worktreePath = mkdtempSync(path.join(tmpdir(), "workers-claude-hook-"));
    const dotClaudeDir = path.join(worktreePath, ".claude");
    const settingsPath = path.join(dotClaudeDir, "settings.local.json");
    mkdirSync(dotClaudeDir, { recursive: true });
    writeFileSync(
      path.join(worktreePath, "TODO.md"),
      "## In progress\n\n- Build feature\n",
      "utf8",
    );

    const session = setupManagedInteractiveClaudeSession(
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
    expect(Array.isArray(settings.hooks.Stop)).toBe(true);
    expect(settings.hooks.Stop).toHaveLength(1);

    session.cleanup();

    expect(() => readFileSync(settingsPath, "utf8")).toThrow();
  });

  test("injects hook alongside existing settings", () => {
    const worktreePath = mkdtempSync(path.join(tmpdir(), "workers-claude-hook-existing-"));
    const dotClaudeDir = path.join(worktreePath, ".claude");
    const settingsPath = path.join(dotClaudeDir, "settings.local.json");
    mkdirSync(dotClaudeDir, { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          permissions: { allow: ["Bash"] },
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

    const session = setupManagedInteractiveClaudeSession(
      worktreePath,
      "- Build feature\n  - Repo: /tmp/example",
      "Implement the task",
      {},
    );

    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      permissions: { allow: string[] };
      hooks: Record<string, unknown[]>;
    };
    expect(settings.permissions.allow).toEqual(["Bash"]);
    expect(settings.hooks.Stop).toHaveLength(1);

    session.cleanup();

    const restored = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      permissions: { allow: string[] };
      hooks?: Record<string, unknown[]>;
    };
    expect(restored.permissions.allow).toEqual(["Bash"]);
    expect(restored.hooks).toBeUndefined();
  });

  test("stop hook records needs_user and done states", () => {
    const worktreePath = mkdtempSync(path.join(tmpdir(), "workers-claude-stop-"));
    const statusFile = path.join(worktreePath, "status.json");
    const todoPath = path.join(worktreePath, "TODO.md");
    const hookScript = path.resolve("src/scripts/claude-stop-hook.mjs");

    writeFileSync(todoPath, "## In progress\n\n- Build feature\n", "utf8");

    const needsUser = spawnSync(process.execPath, [hookScript], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        WORKERS_CLAUDE_STATUS_FILE: statusFile,
        WORKERS_LOCAL_TODO_PATH: todoPath,
        WORKERS_TODO_SUMMARY: "Build feature",
      },
      input: JSON.stringify({
        last_assistant_message: "I need one decision.\nWORKERS_STATUS: NEEDS_USER",
        session_id: "session-1",
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
        WORKERS_CLAUDE_STATUS_FILE: statusFile,
        WORKERS_LOCAL_TODO_PATH: todoPath,
        WORKERS_TODO_SUMMARY: "Build feature",
      },
      input: JSON.stringify({
        last_assistant_message: "Implemented and committed.\nWORKERS_STATUS: DONE",
        session_id: "session-1",
      }),
      encoding: "utf8",
    });

    expect(done.status).toBe(0);
    expect(JSON.parse(readFileSync(statusFile, "utf8")).status).toBe("done");
  });
});
