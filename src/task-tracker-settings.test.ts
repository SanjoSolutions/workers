import path from "path";
import { describe, expect, test } from "vitest";
import type { WorkersSettings } from "./settings.js";
import {
  applyGitHubTokenForRepo,
  applyGitHubTokenToEnv,
  resolveGitHubAuthentication,
  resolveTaskTrackerForRepo,
  resolveTaskTrackers,
} from "./task-tracker-settings.js";

const BASE_SETTINGS: WorkersSettings = {
  defaults: {
    cli: "codex",
    model: "gpt-5.4",
    autoModelSelection: true,
    autoModelSelectionModels: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"],
    autoReasoningEffort: true,
  },
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

function normalizeExpectedPath(value: string): string {
  return path.resolve(value);
}

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
    expect(tracker.repo).toBe(normalizeExpectedPath("/home/jonas/openclaw-todos"));
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
    expect(tracker.repo).toBe(normalizeExpectedPath("/home/jonas/todos"));
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
    expect(envTracker.repo).toBe(normalizeExpectedPath("/home/jonas/todos"));
  });

  test("injects GH_TOKEN into a provided env for a repo with a GitHub tracker", async () => {
    const env: NodeJS.ProcessEnv = {};
    const command = `"${process.execPath}" -e "process.stdout.write('repo-token')"`;
    const settings: WorkersSettings = {
      ...BASE_SETTINGS,
      projects: [
        {
          repo: "/home/jonas/workers",
          taskTracker: {
            type: "github-issues",
            repository: "SanjoSolutions/workers",
            tokenCommand: command,
          },
        },
      ],
    };

    await applyGitHubTokenForRepo(settings, "/home/jonas/workers", env);

    expect(env.GH_TOKEN).toBe("repo-token");
  });

  test("defaults GitHub issue trackers to ready, in-progress, and pr-ready labels", () => {
    const tracker = resolveTaskTrackerForRepo(
      "/home/jonas/workers",
      {
        ...BASE_SETTINGS,
        projects: [
          {
            repo: "/home/jonas/workers",
            taskTracker: {
              type: "github-issues",
              repository: "SanjoSolutions/workers",
            },
          },
        ],
      },
      {},
    );

    expect(tracker.kind).toBe("github-issues");
    if (tracker.kind !== "github-issues") {
      throw new Error("expected github-issues tracker");
    }

    expect(tracker.labels).toEqual({
      ready: "workers:ready-to-be-picked-up",
      inProgress: "workers:in-progress",
      prReady: "workers:pr-ready",
    });
    expect(tracker.claimComment).toEqual({
      message: "I will work on this.",
    });
  });

  test("resolves a configured GitHub issue claim comment message", () => {
    const tracker = resolveTaskTrackerForRepo(
      "/home/jonas/workers",
      {
        ...BASE_SETTINGS,
        projects: [
          {
            repo: "/home/jonas/workers",
            taskTracker: {
              type: "github-issues",
              repository: "SanjoSolutions/workers",
              claimComment: {
                message: "Starting this task now.",
              },
            },
          },
        ],
      },
      {},
    );

    expect(tracker.kind).toBe("github-issues");
    if (tracker.kind !== "github-issues") {
      throw new Error("expected github-issues tracker");
    }

    expect(tracker.claimComment).toEqual({
      message: "Starting this task now.",
    });
  });

  test("leaves env untouched when the repo has no configured tracker", async () => {
    const env: NodeJS.ProcessEnv = { GH_TOKEN: "existing-token" };

    await applyGitHubTokenForRepo(
      {
        ...BASE_SETTINGS,
        projects: [],
      },
      "/home/jonas/workers",
      env,
    );

    expect(env.GH_TOKEN).toBe("existing-token");
  });

  test("injects GH_TOKEN without mutating process.env", async () => {
    const env: NodeJS.ProcessEnv = {};
    const trackers = {
      workers: {
        name: "workers",
        kind: "github-issues" as const,
        repository: "SanjoSolutions/workers",
        defaultRepo: "/home/jonas/workers",
        tokenCommand: `"${process.execPath}" -e "process.stdout.write('shared-token')"`,
        githubApp: undefined,
        labels: {
          ready: "ready",
          inProgress: "in-progress",
        },
        claimComment: {
          message: "I will work on this.",
        },
      },
    };

    delete process.env.GH_TOKEN;
    await applyGitHubTokenToEnv(trackers, env);

    expect(env.GH_TOKEN).toBe("shared-token");
    expect(process.env.GH_TOKEN).toBeUndefined();
  });

  test("prefers the shared GitHub App configuration for authentication", () => {
    const auth = resolveGitHubAuthentication({
      ...BASE_SETTINGS,
      githubApp: {
        appId: "12345",
        privateKeyPath: "~/.config/workers/github-app.pem",
      },
      projects: [
        {
          repo: "/home/jonas/openclaw",
          taskTracker: {
            type: "github-issues",
            repository: "acme/openclaw",
            tokenCommand: "gh auth token",
          },
        },
      ],
    });

    expect(auth).toEqual({
      githubApp: {
        appId: "12345",
        privateKeyPath: "~/.config/workers/github-app.pem",
      },
      tokenCommand: undefined,
    });
  });

  test("falls back to tracker authentication when no shared GitHub App is configured", () => {
    const auth = resolveGitHubAuthentication({
      ...BASE_SETTINGS,
      projects: [
        {
          repo: "/home/jonas/openclaw",
          taskTracker: {
            type: "github-issues",
            repository: "acme/openclaw",
            tokenCommand: "gh auth token",
          },
        },
      ],
    });

    expect(auth).toEqual({
      githubApp: undefined,
      tokenCommand: "gh auth token",
    });
  });
});
