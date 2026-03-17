import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { spawnSync } from "child_process";
import { describe, expect, test } from "vitest";
import { setupManagedInteractiveCodexSession } from "./codex.js";

describe("codex interactive workers hook", () => {
  test("injects and restores worktree hooks for managed interactive sessions", () => {
    const worktreePath = mkdtempSync(path.join(tmpdir(), "workers-codex-hook-"));
    const dotCodexDir = path.join(worktreePath, ".codex");
    const hooksPath = path.join(dotCodexDir, "hooks.json");
    mkdirSync(dotCodexDir, { recursive: true });
    writeFileSync(
      hooksPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
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

    const session = setupManagedInteractiveCodexSession(
      worktreePath,
      "- Build feature\n  - Repo: /tmp/example",
      "Implement the task",
      {},
    );

    expect(session.nextPrompt).toContain("WORKERS_STATUS: NEEDS_USER");
    expect(session.nextPrompt).toContain("WORKERS_STATUS: DONE");

    const hooks = JSON.parse(readFileSync(hooksPath, "utf8")) as {
      hooks: Record<string, unknown[]>;
    };
    expect(hooks.hooks.SessionStart).toHaveLength(1);
    expect(Array.isArray(hooks.hooks.Stop)).toBe(true);
    expect(hooks.hooks.Stop).toHaveLength(1);

    session.cleanup();

    const restored = JSON.parse(readFileSync(hooksPath, "utf8")) as {
      hooks: Record<string, unknown[]>;
    };
    expect(restored.hooks.Stop).toBeUndefined();
    expect(restored.hooks.SessionStart).toHaveLength(1);
  });

  test("stop hook records needs_user and done states", () => {
    const worktreePath = mkdtempSync(path.join(tmpdir(), "workers-codex-stop-"));
    const statusFile = path.join(worktreePath, "status.json");
    const todoPath = path.join(worktreePath, "TODO.md");
    const hookScript = path.resolve("scripts/codex-stop-hook.mjs");

    writeFileSync(todoPath, "## In progress\n\n- Build feature\n", "utf8");

    const needsUser = spawnSync(process.execPath, [hookScript], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        WORKERS_CODEX_STATUS_FILE: statusFile,
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
        WORKERS_CODEX_STATUS_FILE: statusFile,
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
