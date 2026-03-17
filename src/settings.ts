import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import readline from "readline/promises";
import { fileURLToPath } from "url";
import type { CliName } from "./types.js";

const VALID_CLIS: CliName[] = ["claude", "codex", "gemini"];
const VALID_CLI_SET = new Set<CliName>(VALID_CLIS);

export interface WorkerDefaults {
  cli: CliName;
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
}

interface SettingsLoadOptions {
  env?: NodeJS.ProcessEnv;
  promptForCli?: (choices: CliName[]) => Promise<CliName>;
  /** Override the config directory (for testing). When set, the template is also loaded from this directory. */
  configDir?: string;
}

export function workersRepoRoot(): string {
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

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    process.stdout.write(`Choose the default ${label} CLI:\n`);
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
  cfgDir: string,
  templateRepoRoot: string,
  options: SettingsLoadOptions,
): Promise<string> {
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

  try {
    const parsed = parseSettingsFile(filePath);
    const worker = (parsed.worker ?? {}) as Record<string, unknown>;
    const defaults = (worker.defaults ?? {}) as Record<string, unknown>;
    const configuredCli = defaults.cli;

    if (typeof configuredCli === "string") {
      if (!VALID_CLI_SET.has(configuredCli as CliName)) {
        throw new Error(
          `Invalid settings in ${filePath}: worker.defaults.cli must be one of claude, codex, gemini.`,
        );
      }
      return filePath;
    }

    const installed = detectInstalledClis(options.env ?? process.env);
    if (installed.length === 0) {
      throw new Error(
        "No supported worker CLI is installed. Install codex, claude, or gemini, or set worker.defaults.cli manually in settings.json.",
      );
    }

    const promptFn = options.promptForCli ?? ((choices: CliName[]) => promptForCli(choices, "worker", "worker.defaults.cli"));
    const chosen =
      installed.length === 1
        ? installed[0]
        : await promptFn(installed);

    defaults.cli = chosen;
    worker.defaults = defaults;
    parsed.worker = worker;
    if (installed.length === 1) {
      process.stdout.write(
        `Auto-selected default worker CLI: ${chosen} (the only supported CLI installed).\n`,
      );
    }

    // Also set assistant CLI
    const assistant = (parsed.assistant ?? {}) as Record<string, unknown>;
    const assistantDefaults = (assistant.defaults ?? {}) as Record<string, unknown>;
    if (typeof assistantDefaults.cli !== "string") {
      const assistantPromptFn = options.promptForCli ?? ((choices: CliName[]) => promptForCli(choices, "assistant", "assistant.defaults.cli"));
      const assistantChosen =
        installed.length === 1
          ? installed[0]
          : await assistantPromptFn(installed);

      assistantDefaults.cli = assistantChosen;
      assistant.defaults = assistantDefaults;
      parsed.assistant = assistant;
      if (installed.length === 1) {
        process.stdout.write(
          `Auto-selected default assistant CLI: ${assistantChosen} (the only supported CLI installed).\n`,
        );
      }
    }

    writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    return filePath;
  } catch (error) {
    rmSync(filePath, { force: true });
    throw error;
  }
}

export async function loadSettings(
  repoRoot = workersRepoRoot(),
  options: SettingsLoadOptions = {},
): Promise<WorkersSettings> {
  const cfgDir = options.configDir ?? configDir();
  const templateRoot = options.configDir ?? repoRoot;
  const filePath = await initializeSettingsFile(cfgDir, templateRoot, options);
  const parsed = parseSettingsFile(filePath);
  const worker = (parsed.worker ?? {}) as Record<string, unknown>;
  const defaults = (worker.defaults ?? {}) as Record<string, unknown>;
  const cli = defaults.cli;

  if (typeof cli !== "string" || !VALID_CLI_SET.has(cli as CliName)) {
    throw new Error(
      `Invalid settings in ${filePath}: worker.defaults.cli must be one of claude, codex, gemini.`,
    );
  }

  const assistant = (parsed.assistant ?? {}) as Record<string, unknown>;
  const assistantDefaults = (assistant.defaults ?? {}) as Record<string, unknown>;
  const assistantCli =
    typeof assistantDefaults.cli === "string" && VALID_CLI_SET.has(assistantDefaults.cli as CliName)
      ? (assistantDefaults.cli as CliName)
      : undefined;

  return {
    defaults: {
      cli: cli as CliName,
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

/**
 * Ensure assistant.defaults.cli is set. If not, detect/prompt and persist.
 * Returns the resolved CLI name.
 */
export async function ensureAssistantCli(
  settings: WorkersSettings,
  cfgDir = configDir(),
): Promise<CliName> {
  if (settings.assistant.defaults.cli) {
    return settings.assistant.defaults.cli;
  }

  const installed = detectInstalledClis(process.env);
  if (installed.length === 0) {
    throw new Error(
      "No supported CLI is installed. Install codex, claude, or gemini, or set assistant.defaults.cli manually in settings.json.",
    );
  }

  const chosen =
    installed.length === 1
      ? installed[0]
      : await promptForCli(installed, "assistant", "assistant.defaults.cli");

  if (installed.length === 1) {
    process.stdout.write(
      `Auto-selected default assistant CLI: ${chosen} (the only supported CLI installed).\n`,
    );
  }

  // Persist to settings
  const filePath = settingsPath(cfgDir);
  if (existsSync(filePath)) {
    const parsed = parseSettingsFile(filePath);
    const assistant = (parsed.assistant ?? {}) as Record<string, unknown>;
    const assistantDefaults = (assistant.defaults ?? {}) as Record<string, unknown>;
    assistantDefaults.cli = chosen;
    assistant.defaults = assistantDefaults;
    parsed.assistant = assistant;
    writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  }

  settings.assistant.defaults.cli = chosen;
  return chosen;
}
