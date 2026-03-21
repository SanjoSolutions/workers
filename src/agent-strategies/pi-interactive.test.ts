import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { describe, expect, test, vi } from "vitest";
import { setupManagedInteractivePiSession } from "./pi.js";
import { PiAgentStrategy } from "./pi.js";
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

describe("pi interactive workers session", () => {
  test("creates status file and sets env vars", () => {
    const worktreePath = mkdtempSync(path.join(tmpdir(), "workers-pi-session-"));
    writeFileSync(
      path.join(worktreePath, "TODO.md"),
      "## In progress\n\n- Build feature\n",
      "utf8",
    );

    const session = setupManagedInteractivePiSession(
      worktreePath,
      "- Build feature\n  - Repo: /tmp/example",
      "Implement the task",
      {},
    );

    expect(session.nextPrompt).toContain("WORKERS_STATUS: NEEDS_USER");
    expect(session.nextPrompt).toContain("WORKERS_STATUS: DONE");
    expect(session.env.WORKERS_PI_STATUS_FILE).toBeTruthy();
    expect(session.env.WORKERS_TODO_SUMMARY).toBe("Build feature");
    expect(session.env.WORKERS_LOCAL_TODO_PATH).toBeTruthy();

    const statusJson = JSON.parse(readFileSync(session.statusFile, "utf8")) as {
      status: string;
      launcherPid: number;
      startedAt: string;
    };
    expect(statusJson.status).toBe("running");
    expect(statusJson.launcherPid).toBe(process.pid);
    expect(statusJson.startedAt).toBeTruthy();

    // Cleanup is a no-op; just verify it does not throw
    expect(() => session.cleanup()).not.toThrow();
  });
});

describe("pi agent_end extension handler", () => {
  test("writes needs_user status when marker present", async () => {
    const worktreePath = mkdtempSync(path.join(tmpdir(), "workers-pi-ext-"));
    const statusFile = path.join(worktreePath, "status.json");
    const todoPath = path.join(worktreePath, "TODO.md");
    writeFileSync(todoPath, "## In progress\n\n- Build feature\n", "utf8");

    const originalEnv = { ...process.env };
    process.env.WORKERS_PI_STATUS_FILE = statusFile;
    process.env.WORKERS_LOCAL_TODO_PATH = todoPath;
    process.env.WORKERS_TODO_SUMMARY = "Build feature";

    try {
      const ext = await import("../scripts/pi-agent-end-extension.mjs");
      const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
      const mockPi = {
        on: (event: string, handler: (...args: unknown[]) => Promise<unknown>) => {
          handlers.set(event, handler);
        },
      };
      ext.default(mockPi);

      const handler = handlers.get("agent_end");
      expect(handler).toBeDefined();

      await handler!({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "I need input.\nWORKERS_STATUS: NEEDS_USER" }],
          },
        ],
      });

      const result = JSON.parse(readFileSync(statusFile, "utf8")) as { status: string };
      expect(result.status).toBe("needs_user");
    } finally {
      process.env = originalEnv;
    }
  });

  test("writes done status when DONE marker present", async () => {
    const worktreePath = mkdtempSync(path.join(tmpdir(), "workers-pi-ext-done-"));
    const statusFile = path.join(worktreePath, "status.json");
    const todoPath = path.join(worktreePath, "TODO.md");
    writeFileSync(todoPath, "## In progress\n\n- Build feature\n", "utf8");

    const originalEnv = { ...process.env };
    process.env.WORKERS_PI_STATUS_FILE = statusFile;
    process.env.WORKERS_LOCAL_TODO_PATH = todoPath;
    process.env.WORKERS_TODO_SUMMARY = "Build feature";

    try {
      const ext = await import("../scripts/pi-agent-end-extension.mjs");
      const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
      const mockPi = {
        on: (event: string, handler: (...args: unknown[]) => Promise<unknown>) => {
          handlers.set(event, handler);
        },
      };
      ext.default(mockPi);

      const handler = handlers.get("agent_end");
      await handler!({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "All done.\nWORKERS_STATUS: DONE" }],
          },
        ],
      });

      const result = JSON.parse(readFileSync(statusFile, "utf8")) as { status: string };
      expect(result.status).toBe("done");
    } finally {
      process.env = originalEnv;
    }
  });

  test("writes done status when TODO no longer contains summary", async () => {
    const worktreePath = mkdtempSync(path.join(tmpdir(), "workers-pi-ext-todo-"));
    const statusFile = path.join(worktreePath, "status.json");
    const todoPath = path.join(worktreePath, "TODO.md");
    writeFileSync(todoPath, "## In progress\n\n", "utf8");

    const originalEnv = { ...process.env };
    process.env.WORKERS_PI_STATUS_FILE = statusFile;
    process.env.WORKERS_LOCAL_TODO_PATH = todoPath;
    process.env.WORKERS_TODO_SUMMARY = "Build feature";

    try {
      const ext = await import("../scripts/pi-agent-end-extension.mjs");
      const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
      const mockPi = {
        on: (event: string, handler: (...args: unknown[]) => Promise<unknown>) => {
          handlers.set(event, handler);
        },
      };
      ext.default(mockPi);

      const handler = handlers.get("agent_end");
      await handler!({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "All committed." }],
          },
        ],
      });

      const result = JSON.parse(readFileSync(statusFile, "utf8")) as { status: string };
      expect(result.status).toBe("done");
    } finally {
      process.env = originalEnv;
    }
  });

  test("writes continue status when no markers and TODO still contains summary", async () => {
    const worktreePath = mkdtempSync(path.join(tmpdir(), "workers-pi-ext-cont-"));
    const statusFile = path.join(worktreePath, "status.json");
    const todoPath = path.join(worktreePath, "TODO.md");
    writeFileSync(todoPath, "## In progress\n\n- Build feature\n", "utf8");

    const originalEnv = { ...process.env };
    process.env.WORKERS_PI_STATUS_FILE = statusFile;
    process.env.WORKERS_LOCAL_TODO_PATH = todoPath;
    process.env.WORKERS_TODO_SUMMARY = "Build feature";

    try {
      const ext = await import("../scripts/pi-agent-end-extension.mjs");
      const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
      const mockPi = {
        on: (event: string, handler: (...args: unknown[]) => Promise<unknown>) => {
          handlers.set(event, handler);
        },
      };
      ext.default(mockPi);

      const handler = handlers.get("agent_end");
      await handler!({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Working on it..." }],
          },
        ],
      });

      const result = JSON.parse(readFileSync(statusFile, "utf8")) as { status: string };
      expect(result.status).toBe("continue");
    } finally {
      process.env = originalEnv;
    }
  });

  test("does nothing when WORKERS_PI_STATUS_FILE is not set", async () => {
    const originalEnv = { ...process.env };
    delete process.env.WORKERS_PI_STATUS_FILE;

    try {
      const ext = await import("../scripts/pi-agent-end-extension.mjs");
      const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
      const mockPi = {
        on: (event: string, handler: (...args: unknown[]) => Promise<unknown>) => {
          handlers.set(event, handler);
        },
      };
      ext.default(mockPi);

      const handler = handlers.get("agent_end");
      // Should not throw
      await expect(handler!({ type: "agent_end", messages: [] })).resolves.toBeUndefined();
    } finally {
      process.env = originalEnv;
    }
  });
});

describe("PiAgentStrategy", () => {
  const strategy = new PiAgentStrategy();
  const packageRoot = determinePackageRoot();
  const worktreePath = "/worktree";
  const baseContext = {
    worktreePath,
    claimedTodoItem: "- Build feature",
    nextPrompt: "Implement it",
    env: {},
    options: {
      model: undefined,
      interactive: false,
      modelDefault: undefined,
    },
    noTodo: false,
    config: undefined,
    claimedTodoItemType: "unknown",
    workflowMode: "worker",
  };

  test("passes --tools and --system-prompt in non-interactive mode", async () => {
    await strategy.launch(baseContext as any);

    expect(spawnAgentProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "pi",
        args: expect.arrayContaining(["-p", "Implement it"]),
        captureOutput: true,
      }),
    );

    const call = (spawnAgentProcess as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    expect(call.args).toContain("--tools");
    expect(call.args).toContain("--system-prompt");
    expect(call.args).toContain("read,bash,edit,write");
  });

  test("uses piDefaultModel from config when no model option", async () => {
    await strategy.launch({
      ...baseContext,
      config: { projectName: "test", agent: { piDefaultModel: "claude-opus-4-6" } },
    } as any);

    const call = (spawnAgentProcess as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    expect(call.args).toContain("--model");
    expect(call.args).toContain("claude-opus-4-6");
  });

  test("uses piDefaultTools from config", async () => {
    await strategy.launch({
      ...baseContext,
      config: { projectName: "test", agent: { piDefaultTools: ["read", "bash"] } },
    } as any);

    const call = (spawnAgentProcess as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    expect(call.args).toContain("read,bash");
  });

  test("uses assistant SYSTEM.md for noTodo mode", async () => {
    await strategy.launch({ ...baseContext, noTodo: true } as any);

    const call = (spawnAgentProcess as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    const systemPromptIdx = call.args.indexOf("--system-prompt");
    expect(systemPromptIdx).toBeGreaterThan(-1);
    const systemPromptContent = call.args[systemPromptIdx + 1] as string;
    expect(systemPromptContent).toContain("Plan behavior depends on the capabilities available in the current environment:");
    expect(systemPromptContent).not.toContain("EnterPlanMode");
    expect(systemPromptContent).not.toContain("`update_plan`");
    expect(systemPromptContent).not.toContain("{{#cli");
  });

  test("includes --extension flag and prompt in interactive mode", async () => {
    const { spawnManagedInteractiveAgent } = await import("./managed-interactive.js");

    const tempWorktree = mkdtempSync(path.join(tmpdir(), "workers-pi-launch-"));
    writeFileSync(
      path.join(tempWorktree, "TODO.md"),
      "## In progress\n\n- Build feature\n",
      "utf8",
    );

    await strategy.launch({
      ...baseContext,
      worktreePath: tempWorktree,
      options: { ...baseContext.options, interactive: true },
    } as any);

    expect(spawnManagedInteractiveAgent).toHaveBeenCalledWith(
      "pi",
      expect.arrayContaining(["--extension", expect.stringContaining("pi-agent-end-extension.mjs")]),
      tempWorktree,
      expect.objectContaining({
        WORKERS_PI_STATUS_FILE: expect.any(String),
        WORKERS_TODO_SUMMARY: expect.any(String),
        WORKERS_LOCAL_TODO_PATH: expect.any(String),
      }),
      expect.any(String),
      expect.any(Function),
    );
  });
});
