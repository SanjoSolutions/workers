import path from "path";
import { extractTodoField } from "./agent-prompt.js";
import type {
  ProjectTaskTrackerSettings,
  GitTodoTaskTrackerSettings,
  WorkersSettings,
} from "./settings.js";

export interface ResolvedGitTodoTaskTracker {
  name: string;
  kind: "git-todo";
  repo: string;
  file: string;
}

function readEnv(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function expandHomePath(rawPath: string): string {
  if (!rawPath.startsWith("~/")) {
    return rawPath;
  }

  const homeDir = process.env.HOME;
  if (!homeDir) {
    return rawPath;
  }

  return path.join(homeDir, rawPath.slice(2));
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

export function resolveTaskTrackers(
  settings: WorkersSettings,
  env: NodeJS.ProcessEnv = process.env,
): {
  trackers: Record<string, ResolvedGitTodoTaskTracker>;
  defaultTrackerName: string | undefined;
} {
  const trackers = Object.fromEntries(
    Object.entries(settings.taskTrackers).map(([name, tracker]) => [
      name,
      resolveGitTodoTracker(name, tracker),
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
  projects: Record<string, ProjectTaskTrackerSettings>,
): string | undefined {
  const normalizedRepo = normalizeProjectKey(repoPath);

  for (const [projectPath, config] of Object.entries(projects)) {
    if (normalizeProjectKey(projectPath) === normalizedRepo) {
      return config.taskTracker?.trim() || undefined;
    }
  }

  return undefined;
}

export function resolveTaskTrackerForTodoText(
  todoText: string,
  settings: WorkersSettings,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedGitTodoTaskTracker {
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
