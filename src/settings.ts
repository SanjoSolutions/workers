import { accessSync, constants, copyFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import readline from "readline/promises";
import { fileURLToPath } from "url";
import type { CliName } from "./types.js";

const VALID_CLIS: CliName[] = ["claude", "codex", "gemini"];
const VALID_CLI_SET = new Set<CliName>(VALID_CLIS);

export interface WorkersSettings {
  defaultCli: CliName;
  model: string;
  defaultTaskTracker: string | undefined;
  taskTrackers: Record<string, TaskTrackerSettings>;
  projects: ProjectTaskTrackerSettings[];
}

export interface GitTodoTaskTrackerSettings {
  type?: "git-todo";
  repo: string;
  file?: string;
}

export interface GitHubIssueLabelsSettings {
  planned?: string;
  ready?: string;
  inProgress?: string;
}

export interface GitHubIssuesTaskTrackerSettings {
  type: "github-issues";
  repository: string;
  labels?: GitHubIssueLabelsSettings;
}

export type TaskTrackerSettings =
  | GitTodoTaskTrackerSettings
  | GitHubIssuesTaskTrackerSettings;

export interface ProjectTaskTrackerSettings {
  repo: string;
  taskTracker?: string;
}

interface SettingsLoadOptions {
  env?: NodeJS.ProcessEnv;
  promptForCli?: (choices: CliName[]) => Promise<CliName>;
}

function workersRepoRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), "..");
}

export function settingsPath(repoRoot = workersRepoRoot()): string {
  return path.join(repoRoot, "settings.json");
}

function settingsTemplatePath(repoRoot = workersRepoRoot()): string {
  return path.join(repoRoot, "settings.template.json");
}

function parseSettingsFile(filePath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid settings in ${filePath}: expected a JSON object.`);
  }

  return parsed as Record<string, unknown>;
}

function normalizeProjectEntries(
  parsed: Record<string, unknown>,
): ProjectTaskTrackerSettings[] {
  if (!Array.isArray(parsed.projects)) {
    return [];
  }

  return parsed.projects
    .filter((entry): entry is ProjectTaskTrackerSettings => {
      return Boolean(
        entry
        && typeof entry === "object"
        && !Array.isArray(entry)
        && typeof (entry as { repo?: unknown }).repo === "string"
        && (entry as { repo: string }).repo.trim(),
      );
    })
    .map((entry) => ({
      repo: entry.repo.trim(),
      taskTracker:
        typeof entry.taskTracker === "string" && entry.taskTracker.trim()
          ? entry.taskTracker.trim()
          : undefined,
    }));
}

function normalizeTaskTrackerSettings(
  parsed: Record<string, unknown>,
): Record<string, TaskTrackerSettings> {
  if (!parsed.taskTrackers || typeof parsed.taskTrackers !== "object" || Array.isArray(parsed.taskTrackers)) {
    return {};
  }

  const normalized: Record<string, TaskTrackerSettings> = {};

  for (const [name, rawTracker] of Object.entries(parsed.taskTrackers)) {
    if (!rawTracker || typeof rawTracker !== "object" || Array.isArray(rawTracker)) {
      continue;
    }

    if ((rawTracker as { type?: unknown }).type === "github-issues") {
      const repository = typeof (rawTracker as { repository?: unknown }).repository === "string"
        ? (rawTracker as { repository: string }).repository.trim()
        : "";
      if (!repository) {
        continue;
      }

      const rawLabels = (rawTracker as { labels?: unknown }).labels;
      const labels =
        rawLabels && typeof rawLabels === "object" && !Array.isArray(rawLabels)
          ? {
              planned:
                typeof (rawLabels as { planned?: unknown }).planned === "string"
                && (rawLabels as { planned: string }).planned.trim()
                  ? (rawLabels as { planned: string }).planned.trim()
                  : undefined,
              ready:
                typeof (rawLabels as { ready?: unknown }).ready === "string"
                && (rawLabels as { ready: string }).ready.trim()
                  ? (rawLabels as { ready: string }).ready.trim()
                  : undefined,
              inProgress:
                typeof (rawLabels as { inProgress?: unknown }).inProgress === "string"
                && (rawLabels as { inProgress: string }).inProgress.trim()
                  ? (rawLabels as { inProgress: string }).inProgress.trim()
                  : undefined,
            }
          : undefined;

      normalized[name] = {
        type: "github-issues",
        repository,
        labels,
      };
      continue;
    }

    const repo = typeof (rawTracker as { repo?: unknown }).repo === "string"
      ? (rawTracker as { repo: string }).repo.trim()
      : "";
    if (!repo) {
      continue;
    }

    normalized[name] = {
      type: "git-todo",
      repo,
      file:
        typeof (rawTracker as { file?: unknown }).file === "string"
        && (rawTracker as { file: string }).file.trim()
          ? (rawTracker as { file: string }).file.trim()
          : undefined,
    };
  }

  return normalized;
}

function detectInstalledClis(env: NodeJS.ProcessEnv): CliName[] {
  const pathValue = env.PATH ?? process.env.PATH ?? "";
  const pathEntries = pathValue.split(path.delimiter).filter(Boolean);

  return VALID_CLIS.filter((cli) => {
    return pathEntries.some((entry) => {
      const candidate = path.join(entry, cli);
      try {
        accessSync(candidate, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  });
}

async function promptForDefaultCli(choices: CliName[]): Promise<CliName> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `Multiple worker CLIs are installed (${choices.join(", ")}). Set defaultCli in settings.json.`,
    );
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    process.stdout.write("Choose the default worker CLI:\n");
    choices.forEach((choice, index) => {
      process.stdout.write(`${index + 1}. ${choice}\n`);
    });

    while (true) {
      const answer = (await rl.question("Selection: ")).trim();
      const numeric = Number.parseInt(answer, 10);
      if (Number.isFinite(numeric) && numeric >= 1 && numeric <= choices.length) {
        return choices[numeric - 1];
      }

      const normalized = answer.toLowerCase();
      if (VALID_CLI_SET.has(normalized as CliName) && choices.includes(normalized as CliName)) {
        return normalized as CliName;
      }

      process.stdout.write(`Enter 1-${choices.length} or one of: ${choices.join(", ")}\n`);
    }
  } finally {
    rl.close();
  }
}

async function initializeSettingsFile(
  repoRoot: string,
  options: SettingsLoadOptions,
): Promise<string> {
  const filePath = settingsPath(repoRoot);
  if (existsSync(filePath)) {
    return filePath;
  }

  const templatePath = settingsTemplatePath(repoRoot);
  if (!existsSync(templatePath)) {
    throw new Error(
      `Cannot initialize ${filePath}: missing template ${templatePath}.`,
    );
  }

  copyFileSync(templatePath, filePath);

  const parsed = parseSettingsFile(filePath);
  const configuredDefault = parsed.defaultCli;

  if (typeof configuredDefault === "string") {
    if (!VALID_CLI_SET.has(configuredDefault as CliName)) {
      throw new Error(
        `Invalid settings in ${filePath}: defaultCli must be one of claude, codex, gemini.`,
      );
    }
    return filePath;
  }

  const installed = detectInstalledClis(options.env ?? process.env);
  if (installed.length === 0) {
    throw new Error(
      "No supported worker CLI is installed. Install codex, claude, or gemini, or set defaultCli manually in settings.json.",
    );
  }

  const chosen =
    installed.length === 1
      ? installed[0]
      : await (options.promptForCli ?? promptForDefaultCli)(installed);

  parsed.defaultCli = chosen;
  writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  if (installed.length === 1) {
    process.stdout.write(
      `Auto-selected default worker CLI: ${chosen} (the only supported CLI installed).\n`,
    );
  }
  return filePath;
}

export async function loadSettings(
  repoRoot = workersRepoRoot(),
  options: SettingsLoadOptions = {},
): Promise<WorkersSettings> {
  const filePath = await initializeSettingsFile(repoRoot, options);
  const parsed = parseSettingsFile(filePath);
  const defaultCli = parsed.defaultCli;

  if (typeof defaultCli !== "string" || !VALID_CLI_SET.has(defaultCli as CliName)) {
    throw new Error(
      `Invalid settings in ${filePath}: defaultCli must be one of claude, codex, gemini.`,
    );
  }

  return {
    defaultCli: defaultCli as CliName,
    model:
      typeof parsed.model === "string" && parsed.model.trim()
        ? parsed.model.trim()
        : "gpt-5.4",
    defaultTaskTracker:
      typeof parsed.defaultTaskTracker === "string" && parsed.defaultTaskTracker.trim()
        ? parsed.defaultTaskTracker.trim()
        : undefined,
    taskTrackers: normalizeTaskTrackerSettings(parsed),
    projects: normalizeProjectEntries(parsed),
  };
}

export function persistProjectSettings(
  updates: {
    repo: string;
    taskTracker?: string;
  }[],
  repoRoot = workersRepoRoot(),
): boolean {
  if (updates.length === 0) {
    return false;
  }

  const filePath = settingsPath(repoRoot);
  if (!existsSync(filePath)) {
    return false;
  }

  const parsed = parseSettingsFile(filePath);
  const projects = normalizeProjectEntries(parsed);
  let changed = false;

  for (const update of updates) {
    const repo = update.repo.trim();
    if (!repo) {
      continue;
    }

    const existing = projects.find((project) => project.repo === repo);
    if (!existing) {
      projects.push({
        repo,
        taskTracker: update.taskTracker?.trim() || undefined,
      });
      changed = true;
      continue;
    }

    const nextTracker = update.taskTracker?.trim() || undefined;
    if (nextTracker && !existing.taskTracker) {
      existing.taskTracker = nextTracker;
      changed = true;
    }
  }

  if (!changed) {
    return false;
  }

  parsed.projects = projects;
  writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return true;
}
