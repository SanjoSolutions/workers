import { describe, expect, test } from "vitest";
import type { WorkersSettings } from "./settings.js";
import {
  resolveTaskTrackerForRepo,
  resolveTaskTrackers,
} from "./task-tracker-settings.js";

const BASE_SETTINGS: WorkersSettings = {
  defaults: { cli: "codex", model: "gpt-5.4" },
  assistant: { defaults: { cli: "codex" } },
  projects: [
    {
      repo: "/home/jonas/openclaw",
      taskTracker: {
        repo: "/home/jonas/openclaw-todos",
        file: "TODO.md",
      },
    },
  ],
};

describe("task tracker settings", () => {
  test("resolves the tracker configured for a project repo", () => {
    const tracker = resolveTaskTrackerForRepo(
      "/home/jonas/openclaw",
      BASE_SETTINGS,
      {},
    );

    expect(tracker.kind).toBe("git-todo");
    if (tracker.kind !== "git-todo") {
      throw new Error("expected git-todo tracker");
    }
    expect(tracker.repo).toBe("/home/jonas/openclaw-todos");
  });

  test("falls back to WORKERS_TODO_REPO when project has no tracker", () => {
    const tracker = resolveTaskTrackerForRepo(
      "/home/jonas/workers",
      BASE_SETTINGS,
      {
        WORKERS_TODO_REPO: "/home/jonas/todos",
        WORKERS_TODO_FILE: "TODO.md",
      },
    );

    expect(tracker.kind).toBe("git-todo");
    if (tracker.kind !== "git-todo") {
      throw new Error("expected git-todo tracker");
    }
    expect(tracker.repo).toBe("/home/jonas/todos");
  });

  test("supports env-based default tracker when settings have no projects", () => {
    const { trackers } = resolveTaskTrackers(
      {
        ...BASE_SETTINGS,
        projects: [],
      },
      {
        WORKERS_TODO_REPO: "/home/jonas/todos",
        WORKERS_TODO_FILE: "TODO.md",
      },
    );

    const envTracker = trackers["__env_default__"];
    expect(envTracker?.kind).toBe("git-todo");
    if (envTracker?.kind !== "git-todo") {
      throw new Error("expected git-todo tracker");
    }
    expect(envTracker.repo).toBe("/home/jonas/todos");
  });
});
