import path from "path";
import { extractTodoField } from "./agent-prompt.js";
import { expandHomePath } from "./path-utils.js";
import { readEnv } from "./env-utils.js";
import type {
  ProjectTaskTrackerSettings,
  GitTodoTaskTrackerSettings,
  GitHubIssuesTaskTrackerSettings,
  WorkersSettings,
} from "./settings.js";

export interface ResolvedGitTodoTaskTracker {
  name: string;
  kind: "git-todo";
  repo: string;
  file: string;
}

export interface ResolvedGitHubIssuesTaskTracker {
  name: string;
  kind: "github-issues";
  repository: string;
  labels: {
    planned: string;
    ready: string;
    inProgress: string;
  };
}

export type ResolvedTaskTracker =
  | ResolvedGitTodoTaskTracker
  | ResolvedGitHubIssuesTaskTracker;

export interface PollableTaskTracker {
  tracker: ResolvedTaskTracker;
  source: "project" | "default";
}

function normalizeProjectKey(projectPath: string): string {
  return path.resolve(expandHomePath(projectPath));
}

function resolveGitTodoTracker(
  name: string,
  tracker: GitTodoTaskTrackerSettings,
): ResolvedGitTodoTaskTracker {
  return {
    name,
    kind: "git-todo",
    repo: normalizeProjectKey(tracker.repo),
    file: tracker.file?.trim() || "TODO.md",
  };
}

function resolveGitHubIssuesTracker(
  name: string,
  tracker: GitHubIssuesTaskTrackerSettings,
): ResolvedGitHubIssuesTaskTracker {
  return {
    name,
    kind: "github-issues",
    repository: tracker.repository.trim(),
    labels: {
      planned: tracker.labels?.planned?.trim() || "workers:planned",
      ready: tracker.labels?.ready?.trim() || "workers:ready",
      inProgress: tracker.labels?.inProgress?.trim() || "workers:in-progress",
    },
  };
}

export function resolveTaskTrackers(
  settings: WorkersSettings,
  env: NodeJS.ProcessEnv = process.env,
): {
  trackers: Record<string, ResolvedTaskTracker>;
  defaultTrackerName: string | undefined;
} {
  const trackers = Object.fromEntries(
    Object.entries(settings.taskTrackers).map(([name, tracker]) => [
      name,
      tracker.type === "github-issues"
        ? resolveGitHubIssuesTracker(name, tracker)
        : resolveGitTodoTracker(name, tracker),
    ]),
  );

  const envRepo = readEnv("WORKERS_TODO_REPO", env);
  if (envRepo) {
    trackers.default = {
      name: "default",
      kind: "git-todo",
      repo: normalizeProjectKey(envRepo),
      file: readEnv("WORKERS_TODO_FILE", env) ?? "TODO.md",
    };
  }

  const defaultTrackerName = settings.defaultTaskTracker?.trim()
    ? settings.defaultTaskTracker.trim()
    : trackers.default
      ? "default"
      : undefined;

  if (defaultTrackerName && !trackers[defaultTrackerName]) {
    throw new Error(
      `Unknown default task tracker "${defaultTrackerName}" in settings.json.`,
    );
  }

  return {
    trackers,
    defaultTrackerName,
  };
}

function resolveProjectTaskTrackerName(
  repoPath: string,
  projects: ProjectTaskTrackerSettings[],
): string | undefined {
  const normalizedRepo = normalizeProjectKey(repoPath);

  for (const project of projects) {
    if (normalizeProjectKey(project.repo) === normalizedRepo) {
      return project.taskTracker?.trim() || undefined;
    }
  }

  return undefined;
}

export function resolveTaskTrackerForTodoText(
  todoText: string,
  settings: WorkersSettings,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedTaskTracker {
  const { trackers, defaultTrackerName } = resolveTaskTrackers(settings, env);
  const repoField = extractTodoField(todoText, "Repo");

  const trackerName =
    repoField && repoField.toLowerCase() !== "none"
      ? resolveProjectTaskTrackerName(repoField, settings.projects)
      : undefined;
  const selectedTrackerName = trackerName ?? defaultTrackerName;

  if (!selectedTrackerName) {
    throw new Error(
      "No task tracker is configured. Set defaultTaskTracker in settings.json or WORKERS_TODO_REPO in the environment.",
    );
  }

  const tracker = trackers[selectedTrackerName];
  if (!tracker) {
    throw new Error(
      `Task tracker "${selectedTrackerName}" is not configured.`,
    );
  }

  return tracker;
}

export function resolvePollingTaskTrackers(
  settings: WorkersSettings,
  env: NodeJS.ProcessEnv = process.env,
): PollableTaskTracker[] {
  const { trackers, defaultTrackerName } = resolveTaskTrackers(settings, env);
  const ordered: PollableTaskTracker[] = [];
  const seen = new Set<string>();

  for (const project of settings.projects) {
    const trackerName = project.taskTracker?.trim() || defaultTrackerName;
    if (!trackerName) {
      continue;
    }

    const tracker = trackers[trackerName];
    if (!tracker || seen.has(tracker.name)) {
      continue;
    }

    ordered.push({
      tracker,
      source: "project",
    });
    seen.add(tracker.name);
  }

  if (defaultTrackerName) {
    const defaultTracker = trackers[defaultTrackerName];
    if (defaultTracker && !seen.has(defaultTracker.name)) {
      ordered.push({
        tracker: defaultTracker,
        source: "default",
      });
    }
  }

  return ordered;
}
