import input from "@inquirer/input"
import select from "@inquirer/select"
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { expandHomePath } from "./path-utils.js"
import type { CliName } from "./types.js"

export const VALID_CLIS: CliName[] = ["claude", "codex", "gemini"];
export const VALID_CLI_SET = new Set<CliName>(VALID_CLIS);

export interface WorkerDefaults {
  cli: CliName | undefined;
  model: string;
}

export interface AssistantDefaults {
  cli: CliName | undefined;
}

export interface WorkersSettings {
  defaults: WorkerDefaults;
  assistant: { defaults: AssistantDefaults };
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
  specInitialized?: boolean;
}

interface SettingsLoadOptions {
  /** Override the config directory (for testing). When set, the template is also loaded from this directory. */
  configDir?: string;
}

export function determinePackageRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), "..");
}

export function configDir(): string {
  if (process.env.WORKERS_CONFIG_DIR) {
    return process.env.WORKERS_CONFIG_DIR;
  }
  const platform = os.platform();
  if (platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "workers");
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "workers");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "workers");
}

export function settingsPath(dir = configDir()): string {
  return path.join(dir, "settings.json");
}

function settingsTemplatePath(repoRoot = determinePackageRoot()): string {
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
      specInitialized:
        typeof (entry as { specInitialized?: unknown }).specInitialized === "boolean"
          ? (entry as { specInitialized: boolean }).specInitialized
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

async function promptForCli(
  choices: CliName[],
  label: string,
  settingsKey: string,
): Promise<CliName> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `Multiple CLIs are installed (${choices.join(", ")}). Set ${settingsKey} in settings.json.`,
    );
  }

  return select<CliName>({
    message: `Choose the default ${label} CLI:`,
    choices: choices.map((cli) => ({ name: cli, value: cli })),
  });
}

function initializeSettingsFile(
  cfgDir: string,
  templateRepoRoot: string,
): string {
  const filePath = settingsPath(cfgDir);
  if (existsSync(filePath)) {
    return filePath;
  }

  const templatePath = settingsTemplatePath(templateRepoRoot);
  if (!existsSync(templatePath)) {
    throw new Error(
      `Cannot initialize ${filePath}: missing template ${templatePath}.`,
    );
  }

  mkdirSync(cfgDir, { recursive: true });
  copyFileSync(templatePath, filePath);
  return filePath;
}

export async function loadSettings(
  repoRoot = determinePackageRoot(),
  options: SettingsLoadOptions = {},
): Promise<WorkersSettings> {
  const cfgDir = options.configDir ?? configDir();
  const templateRoot = options.configDir ?? repoRoot;
  const filePath = initializeSettingsFile(cfgDir, templateRoot);
  const parsed = parseSettingsFile(filePath);
  const worker = (parsed.worker ?? {}) as Record<string, unknown>;
  const defaults = (worker.defaults ?? {}) as Record<string, unknown>;
  const cli = defaults.cli;

  const workerCli =
    typeof cli === "string" && VALID_CLI_SET.has(cli as CliName)
      ? (cli as CliName)
      : undefined;

  const assistant = (parsed.assistant ?? {}) as Record<string, unknown>;
  const assistantDefaults = (assistant.defaults ?? {}) as Record<string, unknown>;
  const assistantCli =
    typeof assistantDefaults.cli === "string" && VALID_CLI_SET.has(assistantDefaults.cli as CliName)
      ? (assistantDefaults.cli as CliName)
      : undefined;

  return {
    defaults: {
      cli: workerCli,
      model:
        typeof defaults.model === "string" && (defaults.model as string).trim()
          ? (defaults.model as string).trim()
          : "gpt-5.4",
    },
    assistant: {
      defaults: {
        cli: assistantCli,
      },
    },
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
  cfgDir = configDir(),
): boolean {
  if (updates.length === 0) {
    return false;
  }

  const filePath = settingsPath(cfgDir);
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

async function ensureCli(
  label: string,
  settingsKey: string,
  current: CliName | undefined,
  persist: (chosen: CliName) => void,
  options?: { env?: NodeJS.ProcessEnv; promptForCli?: (choices: CliName[]) => Promise<CliName> },
): Promise<CliName> {
  if (current) {
    return current;
  }

  const installed = detectInstalledClis(options?.env ?? process.env);
  if (installed.length === 0) {
    throw new Error(
      [
        "No supported agent CLI is installed. Install one or multiple of the following:",
        "",
        "  Codex CLI    https://github.com/openai/codex",
        "  Claude Code  https://docs.anthropic.com/en/docs/claude-code/getting-started",
        "  Gemini CLI   https://github.com/google-gemini/gemini-cli",
      ].join("\n"),
    );
  }

  const promptFn = options?.promptForCli ?? ((choices: CliName[]) => promptForCli(choices, label, settingsKey));
  const chosen =
    installed.length === 1
      ? installed[0]
      : await promptFn(installed);

  if (installed.length === 1) {
    process.stdout.write(
      `Auto-selected default ${label} CLI: ${chosen} (the only supported CLI installed).\n`,
    );
  }

  persist(chosen);
  return chosen;
}

function persistCliSetting(
  cfgDir: string,
  setPath: (parsed: Record<string, unknown>, chosen: CliName) => void,
  chosen: CliName,
): void {
  const filePath = settingsPath(cfgDir);
  if (!existsSync(filePath)) return;
  const parsed = parseSettingsFile(filePath);
  setPath(parsed, chosen);
  writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

/**
 * Ensure worker.defaults.cli is set. If not, detect/prompt and persist.
 */
export async function ensureWorkerCli(
  settings: WorkersSettings,
  cfgDir = configDir(),
  options?: { env?: NodeJS.ProcessEnv; promptForCli?: (choices: CliName[]) => Promise<CliName> },
): Promise<CliName> {
  return ensureCli("worker", "worker.defaults.cli", settings.defaults.cli, (chosen) => {
    persistCliSetting(cfgDir, (parsed, cli) => {
      const worker = (parsed.worker ?? {}) as Record<string, unknown>;
      const defaults = (worker.defaults ?? {}) as Record<string, unknown>;
      defaults.cli = cli;
      worker.defaults = defaults;
      parsed.worker = worker;
    }, chosen);
    settings.defaults.cli = chosen;
  }, options);
}

/**
 * Ensure assistant.defaults.cli is set. If not, detect/prompt and persist.
 */
export async function ensureAssistantCli(
  settings: WorkersSettings,
  cfgDir = configDir(),
): Promise<CliName> {
  return ensureCli("assistant", "assistant.defaults.cli", settings.assistant.defaults.cli, (chosen) => {
    persistCliSetting(cfgDir, (parsed, cli) => {
      const assistant = (parsed.assistant ?? {}) as Record<string, unknown>;
      const assistantDefaults = (assistant.defaults ?? {}) as Record<string, unknown>;
      assistantDefaults.cli = cli;
      assistant.defaults = assistantDefaults;
      parsed.assistant = assistant;
    }, chosen);
    settings.assistant.defaults.cli = chosen;
  });
}

/**
 * Ensure a default task tracker is configured. If not, prompt the user
 * to set one up and persist it.
 */
export async function ensureDefaultTaskTracker(
  settings: WorkersSettings,
  cfgDir = configDir(),
): Promise<void> {
  if (settings.defaultTaskTracker) {
    return;
  }

  // Check if WORKERS_TODO_REPO provides a fallback
  const todoRepo = process.env.WORKERS_TODO_REPO?.trim();
  if (todoRepo) {
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return;
  }

  const trackerType = await select({
    message: "No default task tracker configured. Choose a type:",
    choices: [
      { name: "TODO.md in a Git repo", value: "git-todo" as const },
      { name: "GitHub Issues", value: "github-issues" as const },
    ],
  });

  const filePath = settingsPath(cfgDir);
  if (!existsSync(filePath)) return;
  const parsed = parseSettingsFile(filePath);

  if (trackerType === "git-todo") {
    const repo = await input({ message: "Path to TODO repo:", default: cfgDir });
    if (!repo.trim()) return;
    const resolvedRepo = path.resolve(expandHomePath(repo.trim()));

    const trackers = (parsed.taskTrackers ?? {}) as Record<string, unknown>;
    trackers.default = { repo: resolvedRepo };
    parsed.taskTrackers = trackers;
    parsed.defaultTaskTracker = "default";
    writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    settings.defaultTaskTracker = "default";
    settings.taskTrackers.default = { repo: resolvedRepo };
    process.stdout.write(`Configured TODO repo to ${resolvedRepo}.\n`);
  } else if (trackerType === "github-issues") {
    const repository = await input({ message: "GitHub repository (owner/repo):" });
    if (!repository.trim()) return;

    const trackers = (parsed.taskTrackers ?? {}) as Record<string, unknown>;
    trackers.default = { type: "github-issues", repository: repository.trim() };
    parsed.taskTrackers = trackers;
    parsed.defaultTaskTracker = "default";
    writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    settings.defaultTaskTracker = "default";
    settings.taskTrackers.default = { type: "github-issues", repository: repository.trim() };
    process.stdout.write(`Configured GitHub Issues task tracker for ${repository.trim()}.\n`);
  }
}

/**
 * When a project has no SPEC.md, prompt the user once to initialize it.
 * The decision is persisted per project so the question is never asked again.
 */
export async function ensureProjectSpecInitialized(
  repoRoot: string,
  cfgDir = configDir(),
): Promise<void> {
  // Already initialized — nothing to do.
  if (existsSync(path.join(repoRoot, "SPEC.md"))) {
    return;
  }

  const filePath = settingsPath(cfgDir);
  if (!existsSync(filePath)) return;

  const parsed = parseSettingsFile(filePath);
  const projects = normalizeProjectEntries(parsed);
  const existing = projects.find((p) => p.repo === repoRoot);

  // Already asked (regardless of answer) — respect the saved decision.
  if (existing?.specInitialized !== undefined) {
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return;
  }

  const accepted = await select({
    message: "This project has no SPEC.md. Initialize SPEC.md and AGENTS.md?",
    choices: [
      { name: "Yes", value: true },
      { name: "No", value: false },
    ],
  });

  if (existing) {
    existing.specInitialized = accepted;
  } else {
    projects.push({ repo: repoRoot, specInitialized: accepted });
  }
  parsed.projects = projects;
  writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

  if (accepted) {
    const templateRoot = determinePackageRoot();
    const specTemplate = path.join(templateRoot, "SPEC.template.md");
    const agentsTemplate = path.join(templateRoot, "AGENTS.template.md");

    if (existsSync(specTemplate)) {
      copyFileSync(specTemplate, path.join(repoRoot, "SPEC.md"));
      process.stdout.write("Created SPEC.md.\n");
    }
    if (existsSync(agentsTemplate)) {
      copyFileSync(agentsTemplate, path.join(repoRoot, "AGENTS.md"));
      process.stdout.write("Created AGENTS.md.\n");
    }
  }
}
