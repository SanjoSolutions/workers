import path from "path";
import { expandHomePath } from "./path-utils.js";
import { readEnv } from "./env-utils.js";
import type {
  GitHubAppSettings,
  GitTodoTaskTrackerSettings,
  GitHubIssuesTaskTrackerSettings,
  TaskTrackerSettings,
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
  defaultRepo: string | undefined;
  tokenCommand: string | undefined;
  githubApp: GitHubAppSettings | undefined;
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
  source: "project" | "env";
}

export interface ResolvedGitHubAuthentication {
  githubApp: GitHubAppSettings | undefined;
  tokenCommand: string | undefined;
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
  projectRepo: string | undefined,
): ResolvedGitHubIssuesTaskTracker {
  return {
    name,
    kind: "github-issues",
    repository: tracker.repository.trim(),
    defaultRepo: projectRepo,
    tokenCommand: tracker.tokenCommand?.trim() || undefined,
    githubApp: tracker.githubApp ?? undefined,
    labels: {
      planned: tracker.labels?.planned?.trim() || "workers:planned",
      ready: tracker.labels?.ready?.trim() || "workers:ready-to-be-picked-up",
      inProgress: tracker.labels?.inProgress?.trim() || "workers:in-progress",
    },
  };
}

function resolveTracker(
  name: string,
  tracker: TaskTrackerSettings,
  projectRepo: string | undefined,
): ResolvedTaskTracker {
  return tracker.type === "github-issues"
    ? resolveGitHubIssuesTracker(name, tracker, projectRepo)
    : resolveGitTodoTracker(name, tracker);
}

/**
 * Build a flat record of all resolved trackers from the projects list
 * and the WORKERS_TODO_REPO env var fallback.
 */
export function resolveTaskTrackers(
  settings: WorkersSettings,
  env: NodeJS.ProcessEnv = process.env,
): {
  trackers: Record<string, ResolvedTaskTracker>;
} {
  const trackers: Record<string, ResolvedTaskTracker> = {};

  for (const project of settings.projects) {
    if (!project.taskTracker) continue;
    const name = project.repo;
    trackers[name] = resolveTracker(name, project.taskTracker, normalizeProjectKey(project.repo));
  }

  const envRepo = readEnv("WORKERS_TODO_REPO", env);
  if (envRepo) {
    trackers["__env_default__"] = {
      name: "__env_default__",
      kind: "git-todo",
      repo: normalizeProjectKey(envRepo),
      file: readEnv("WORKERS_TODO_FILE", env) ?? "TODO.md",
    };
  }

  return { trackers };
}

/**
 * Find the tracker configured for a given repo path, or fall back to
 * the WORKERS_TODO_REPO env var tracker.
 */
export function resolveTaskTrackerForRepo(
  repoPath: string,
  settings: WorkersSettings,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedTaskTracker {
  const normalizedRepo = normalizeProjectKey(repoPath);
  const { trackers } = resolveTaskTrackers(settings, env);

  // Direct match by project repo
  const directTracker = trackers[normalizedRepo] ?? trackers[repoPath];
  if (directTracker) return directTracker;

  // Match by scanning projects
  for (const project of settings.projects) {
    if (normalizeProjectKey(project.repo) === normalizedRepo && project.taskTracker) {
      return resolveTracker(project.repo, project.taskTracker, normalizedRepo);
    }
  }

  // Fall back to env-based tracker
  const envTracker = trackers["__env_default__"];
  if (envTracker) return envTracker;

  throw new Error(
    "No task tracker is configured for this project. Add a taskTracker to the project in settings.json or set WORKERS_TODO_REPO.",
  );
}

/**
 * Return all pollable trackers from configured projects + env fallback.
 */
export function resolvePollingTaskTrackers(
  settings: WorkersSettings,
  env: NodeJS.ProcessEnv = process.env,
): PollableTaskTracker[] {
  const ordered: PollableTaskTracker[] = [];
  const seen = new Set<string>();

  for (const project of settings.projects) {
    if (!project.taskTracker) continue;
    const name = project.repo;
    if (seen.has(name)) continue;
    seen.add(name);

    ordered.push({
      tracker: resolveTracker(name, project.taskTracker, normalizeProjectKey(project.repo)),
      source: "project",
    });
  }

  const envRepo = readEnv("WORKERS_TODO_REPO", env);
  if (envRepo) {
    const envKey = "__env_default__";
    if (!seen.has(envKey)) {
      ordered.push({
        tracker: {
          name: envKey,
          kind: "git-todo",
          repo: normalizeProjectKey(envRepo),
          file: readEnv("WORKERS_TODO_FILE", env) ?? "TODO.md",
        },
        source: "env",
      });
    }
  }

  return ordered;
}

async function resolveGitHubTokenFromTracker(
  tracker: ResolvedGitHubIssuesTaskTracker,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  return resolveGitHubToken(
    {
      githubApp: tracker.githubApp,
      tokenCommand: tracker.tokenCommand,
    },
    env,
  );
}

function resolveGitHubAuthenticationFromTrackers(
  trackers: Record<string, ResolvedTaskTracker>,
): ResolvedGitHubAuthentication | undefined {
  for (const tracker of Object.values(trackers)) {
    if (tracker.kind !== "github-issues") {
      continue;
    }

    if (tracker.githubApp) {
      return {
        githubApp: tracker.githubApp,
        tokenCommand: undefined,
      };
    }

    if (tracker.tokenCommand) {
      return {
        githubApp: undefined,
        tokenCommand: tracker.tokenCommand,
      };
    }
  }

  return undefined;
}

async function resolveGitHubToken(
  auth: ResolvedGitHubAuthentication,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (auth.githubApp) {
    const { getGitHubAppInstallationToken } = await import("./github-app-token.js");
    return getGitHubAppInstallationToken(
      auth.githubApp.appId,
      auth.githubApp.privateKeyPath,
    );
  }

  if (auth.tokenCommand) {
    const { execSync } = await import("child_process");
    return execSync(auth.tokenCommand, { encoding: "utf8", env }).trim() || undefined;
  }

  return undefined;
}

export function resolveGitHubAuthentication(
  settings: WorkersSettings,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedGitHubAuthentication | undefined {
  if (settings.githubApp) {
    return {
      githubApp: settings.githubApp,
      tokenCommand: undefined,
    };
  }

  const { trackers } = resolveTaskTrackers(settings, env);
  return resolveGitHubAuthenticationFromTrackers(trackers);
}

export async function applyGitHubTokenFromSettings(
  settings: WorkersSettings,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const auth = resolveGitHubAuthentication(settings, env);
  if (!auth) {
    return;
  }

  const token = await resolveGitHubToken(auth, env);
  if (token) {
    env.GH_TOKEN = token;
  }
}

async function resolveGitHubTokenForRepo(
  settings: WorkersSettings,
  repoPath: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (settings.githubApp) {
    return resolveGitHubToken(
      {
        githubApp: settings.githubApp,
        tokenCommand: undefined,
      },
      env,
    );
  }

  try {
    const tracker = resolveTaskTrackerForRepo(repoPath, settings, env);
    if (tracker.kind !== "github-issues") {
      return undefined;
    }
    return resolveGitHubTokenFromTracker(tracker, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("No task tracker is configured for this project.")) {
      return undefined;
    }
    throw error;
  }
}

export async function applyGitHubTokenToEnv(
  trackers: Record<string, ResolvedTaskTracker>,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const auth = resolveGitHubAuthenticationFromTrackers(trackers);
  if (!auth) {
    return;
  }

  const token = await resolveGitHubToken(auth, env);
  if (token) {
    env.GH_TOKEN = token;
  }
}

export async function applyGitHubTokenForRepo(
  settings: WorkersSettings,
  repoPath: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const token = await resolveGitHubTokenForRepo(settings, repoPath, env);
  if (token) {
    env.GH_TOKEN = token;
  }
}

/**
 * Obtain a fresh GitHub token from the first GitHub Issues tracker that has
 * a githubApp or tokenCommand configured, and set GH_TOKEN in process.env.
 * Safe to call repeatedly (e.g. in a polling loop) to refresh expiring tokens.
 */
export async function applyGitHubToken(
  trackers: Record<string, ResolvedTaskTracker>,
): Promise<void> {
  await applyGitHubTokenToEnv(trackers, process.env);
}
