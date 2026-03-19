import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { describe, expect, test, vi } from "vitest";
import { addTodoToConfiguredTracker } from "./add-todo-command.js";
import type { WorkersSettings } from "./settings.js";

function createSettings(): WorkersSettings {
  return {
    defaults: {
      cli: "codex",
      model: "gpt-5.4",
      autoModelSelection: true,
      autoModelSelectionModels: ["gpt-5.4"],
      autoReasoningEffort: true,
    },
    assistant: {
      defaults: {
        cli: "codex",
      },
    },
    projects: [],
  };
}

describe("addTodoToConfiguredTracker", () => {
  test("routes assistant intake to the configured GitHub issue tracker for the Repo field", async () => {
    const settings = createSettings();
    const applyGitHubTokenFromSettings = vi.fn().mockResolvedValue(undefined);
    const persistProjectSettings = vi.fn();
    const resolveTaskTrackerForRepo = vi.fn().mockReturnValue({
      name: "demo",
      kind: "github-issues",
      repository: "acme/widgets",
      defaultRepo: "/tmp/widgets",
      tokenCommand: undefined,
      githubApp: undefined,
      labels: {
        ready: "workers:ready-to-be-picked-up",
        inProgress: "workers:in-progress",
      },
      claimComment: {
        message: "I will work on this.",
      },
    });
    const createGitHubIssueTask = vi
      .fn()
      .mockResolvedValue("https://github.com/acme/widgets/issues/42");

    const result = await addTodoToConfiguredTracker(
      {
        section: "ready",
        text: "- Ship the change\n  - Repo: /tmp/widgets\n  - Type: Development task",
        issueNumber: 42,
        cwd: "/home/jonas/project",
      },
      {
        loadSettings: vi.fn().mockResolvedValue(settings),
        applyGitHubTokenFromSettings,
        extractTodoField: (text, field) =>
          field === "Repo" ? "/tmp/widgets" : undefined,
        persistProjectSettings,
        hasTaskTracker: () => true,
        promptAndInitTaskTracker: vi.fn(),
        resolveTaskTrackerForRepo,
        fastForwardRepo: vi.fn(),
        withTodoLock: vi.fn(),
        readFile: vi.fn(),
        writeFile: vi.fn(),
        commitAndPushTodoRepo: vi.fn(),
        createGitHubIssueTask,
      },
    );

    expect(applyGitHubTokenFromSettings).toHaveBeenCalledWith(settings);
    expect(persistProjectSettings).toHaveBeenCalledWith([
      { repo: path.resolve("/tmp/widgets") },
    ]);
    expect(resolveTaskTrackerForRepo).toHaveBeenCalledWith(
      path.resolve("/tmp/widgets"),
      settings,
    );
    expect(createGitHubIssueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "github-issues",
        repository: "acme/widgets",
      }),
      "ready",
      [
        "- Ship the change",
        "  - Repo: /tmp/widgets",
        "  - Type: Development task",
      ],
      42,
    );
    expect(result).toBe(
      "Updated item in ready in acme/widgets as GitHub issue https://github.com/acme/widgets/issues/42 (task tracker: demo)",
    );
  });

  test("adds a ready task to a git TODO tracker and commits the update", async () => {
    const settings = createSettings();
    const trackerDir = mkdtempSync(path.join(os.tmpdir(), "workers-add-todo-command-"));
    const todoPath = path.join(trackerDir, "TODO.md");

    writeFileSync(
      todoPath,
      "# TODOs\n\n## In progress\n\n## Ready to be picked up\n\n## Planned\n",
      "utf8",
    );

    const result = await addTodoToConfiguredTracker(
      {
        section: "ready",
        text: "Document the workflow",
        issueNumber: undefined,
        cwd: trackerDir,
      },
      {
        loadSettings: vi.fn().mockResolvedValue(settings),
        applyGitHubTokenFromSettings: vi.fn().mockResolvedValue(undefined),
        extractTodoField: () => undefined,
        persistProjectSettings: vi.fn(),
        hasTaskTracker: () => true,
        promptAndInitTaskTracker: vi.fn(),
        resolveTaskTrackerForRepo: vi.fn().mockReturnValue({
          name: "local",
          kind: "git-todo",
          repo: trackerDir,
          file: "TODO.md",
        }),
        fastForwardRepo: vi.fn().mockResolvedValue(true),
        withTodoLock: vi.fn(async (_todoPath, callback: () => Promise<boolean>) => callback()),
        readFile: (filePath) => readFileSync(filePath, "utf8"),
        writeFile: (filePath, content) => writeFileSync(filePath, content, "utf8"),
        commitAndPushTodoRepo: vi.fn().mockResolvedValue(true),
        createGitHubIssueTask: vi.fn(),
      },
    );

    expect(readFileSync(todoPath, "utf8")).toContain(
      "## Ready to be picked up\n\n- Document the workflow\n",
    );
    expect(result).toBe(
      `Added item to ready in ${todoPath} (task tracker: local)`,
    );
  });
});
