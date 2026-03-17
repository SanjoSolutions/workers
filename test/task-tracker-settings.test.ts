import { describe, expect, test } from "vitest";
import type { WorkersSettings } from "../src/settings.js";
import {
  resolveTaskTrackerForTodoText,
  resolveTaskTrackers,
} from "../src/task-tracker-settings.js";

const BASE_SETTINGS: WorkersSettings = {
  defaultCli: "codex",
  codexModel: "gpt-5.4",
  defaultTaskTracker: "shared",
  taskTrackers: {
    shared: {
      repo: "/home/jonas/todos",
    },
    openclaw: {
      repo: "/home/jonas/openclaw-todos",
      file: "TODO.md",
    },
  },
  projects: {
    "/home/jonas/openclaw": {
      taskTracker: "openclaw",
    },
  },
};

describe("task tracker settings", () => {
  test("routes repo-targeted TODOs to the configured project tracker", () => {
    const tracker = resolveTaskTrackerForTodoText(
      "- Fix OpenClaw task routing\n  - Repo: /home/jonas/openclaw",
      BASE_SETTINGS,
      {},
    );

    expect(tracker.name).toBe("openclaw");
    expect(tracker.repo).toBe("/home/jonas/openclaw-todos");
  });

  test("falls back to the default tracker when a project has no tracker mapping", () => {
    const tracker = resolveTaskTrackerForTodoText(
      "- Fix workers docs\n  - Repo: /home/jonas/workers",
      BASE_SETTINGS,
      {},
    );

    expect(tracker.name).toBe("shared");
    expect(tracker.repo).toBe("/home/jonas/todos");
  });

  test("supports legacy env-based default tracker when settings omit one", () => {
    const { trackers, defaultTrackerName } = resolveTaskTrackers(
      {
        ...BASE_SETTINGS,
        defaultTaskTracker: undefined,
        taskTrackers: {},
      },
      {
        WORKERS_TODO_REPO: "/home/jonas/todos",
        WORKERS_TODO_FILE: "TODO.md",
      },
    );

    expect(defaultTrackerName).toBe("default");
    expect(trackers.default?.repo).toBe("/home/jonas/todos");
  });
});
