import { describe, expect, test, vi } from "vitest";
import { runOrchestrateCli } from "./o.js";

describe("runOrchestrateCli", () => {
  test("prints usage when no subcommand is provided", async () => {
    const stdout = vi.fn<(text: string) => void>();

    const exitCode = await runOrchestrateCli(["node", "o"], {
      handlers: {
        add: vi.fn(),
        assistant: vi.fn(),
        init: vi.fn(),
        list: vi.fn(),
        worker: vi.fn(),
      },
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("Usage: o <command>"));
  });

  test("dispatches assistant subcommands", async () => {
    const assistant = vi.fn(async () => {});

    await runOrchestrateCli(["node", "o", "assistant", "--cli", "pi"], {
      handlers: {
        add: vi.fn(),
        assistant,
        init: vi.fn(),
        list: vi.fn(),
        worker: vi.fn(),
      },
    });

    expect(assistant).toHaveBeenCalledWith(["node", "assistant", "--cli", "pi"]);
  });

  test("dispatches status to the list handler", async () => {
    const list = vi.fn(async () => {});

    await runOrchestrateCli(["node", "o", "status", "--branches"], {
      handlers: {
        add: vi.fn(),
        assistant: vi.fn(),
        init: vi.fn(),
        list,
        worker: vi.fn(),
      },
    });

    expect(list).toHaveBeenCalledWith(["node", "list", "--branches"]);
  });

  test("reports unknown subcommands clearly", async () => {
    const stderr = vi.fn<(text: string) => void>();

    const exitCode = await runOrchestrateCli(["node", "o", "unknown"], {
      handlers: {
        add: vi.fn(),
        assistant: vi.fn(),
        init: vi.fn(),
        list: vi.fn(),
        worker: vi.fn(),
      },
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Unknown command "unknown"'));
  });
});
