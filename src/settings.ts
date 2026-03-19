import select from "@inquirer/select"
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "fs"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { expandHomePath } from "./path-utils.js"
import type { CliName } from "./types.js"

export const VALID_CLIS: CliName[] = ["claude", "codex", "gemini", "pi"];
export const VALID_CLI_SET = new Set<CliName>(VALID_CLIS);
export const DEFAULT_CODEX_AUTO_MODEL_SELECTION_MODELS = [
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
];

export interface WorkerDefaults {
  cli: CliName | undefined;
  model: string;
  autoModelSelection: boolean;
  autoModelSelectionModels: string[];
  autoReasoningEffort: boolean;
}

export interface AssistantDefaults {
  cli: CliName | undefined;
}

export interface WorkersSettings {
  defaults: WorkerDefaults;
  assistant: { defaults: AssistantDefaults };
  githubApp?: GitHubAppSettings;
  projects: ProjectSettings[];
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

export interface GitHubAppSettings {
  appId: string;
  privateKeyPath: string;
}

export interface GitHubIssuesTaskTrackerSettings {
  type: "github-issues";
  repository: string;
  tokenCommand?: string;
  githubApp?: GitHubAppSettings;
  labels?: GitHubIssueLabelsSettings;
}

export type TaskTrackerSettings =
  | GitTodoTaskTrackerSettings
  | GitHubIssuesTaskTrackerSettings;

export interface ProjectSettings {
  repo: string;
  taskTracker?: TaskTrackerSettings;
  createPullRequest?: boolean;
}

interface SettingsLoadOptions {
  /** Override the config directory (for testing). When set, the template is also loaded from this directory. */
  configDir?: string;
}

interface EnsureCliOptions {
  env?: NodeJS.ProcessEnv;
  promptForCli?: (choices: CliName[]) => Promise<CliName>;
  onNonTtyFailure?: () => void;
  preferredCli?: CliName;
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

function normalizeStringArray(raw: unknown, fallback: string[]): string[] {
  if (!Array.isArray(raw)) {
    return [...fallback];
  }

  const values = raw
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);

  if (values.length === 0) {
    return [...fallback];
  }

  return [...new Set(values)];
}

function normalizeGitHubApp(
  raw: unknown,
  location: string,
): GitHubAppSettings | undefined {
  if (raw == null) {
    return undefined;
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `Invalid ${location}: expected an object with non-empty string fields "appId" and "privateKeyPath".`,
    );
  }

  const obj = raw as Record<string, unknown>;
  const appId = typeof obj.appId === "string" ? obj.appId.trim() : "";
  const privateKeyPath =
    typeof obj.privateKeyPath === "string" ? obj.privateKeyPath.trim() : "";

  if (!appId || !privateKeyPath) {
    throw new Error(
      `Invalid ${location}: expected non-empty string fields "appId" and "privateKeyPath".`,
    );
  }

  return {
    appId,
    privateKeyPath,
  };
}

function normalizeInlineTracker(
  raw: unknown,
): TaskTrackerSettings | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }

  const obj = raw as Record<string, unknown>;

  if (obj.type === "github-issues") {
    const repository = typeof obj.repository === "string" ? obj.repository.trim() : "";
    if (!repository) return undefined;

    const rawLabels = obj.labels;
    const labels =
      rawLabels && typeof rawLabels === "object" && !Array.isArray(rawLabels)
        ? {
            planned:
              typeof (rawLabels as Record<string, unknown>).planned === "string"
              && ((rawLabels as Record<string, string>).planned).trim()
                ? ((rawLabels as Record<string, string>).planned).trim()
                : undefined,
            ready:
              typeof (rawLabels as Record<string, unknown>).ready === "string"
              && ((rawLabels as Record<string, string>).ready).trim()
                ? ((rawLabels as Record<string, string>).ready).trim()
                : undefined,
            inProgress:
              typeof (rawLabels as Record<string, unknown>).inProgress === "string"
              && ((rawLabels as Record<string, string>).inProgress).trim()
                ? ((rawLabels as Record<string, string>).inProgress).trim()
                : undefined,
          }
        : undefined;

    const rawTokenCommand = obj.tokenCommand;
    const tokenCommand =
      typeof rawTokenCommand === "string" && rawTokenCommand.trim()
        ? rawTokenCommand.trim()
        : undefined;

    const rawGitHubApp = obj.githubApp;
    const githubApp =
      rawGitHubApp &&
      typeof rawGitHubApp === "object" &&
      !Array.isArray(rawGitHubApp) &&
      typeof (rawGitHubApp as Record<string, unknown>).appId === "string" &&
      typeof (rawGitHubApp as Record<string, unknown>).privateKeyPath === "string"
        ? {
            appId: ((rawGitHubApp as Record<string, string>).appId).trim(),
            privateKeyPath: ((rawGitHubApp as Record<string, string>).privateKeyPath).trim(),
          }
        : undefined;

    return {
      type: "github-issues",
      repository,
      tokenCommand,
      githubApp,
      labels,
    };
  }

  // git-todo tracker (type is optional, defaults to git-todo)
  const repo = typeof obj.repo === "string" ? obj.repo.trim() : "";
  if (!repo) return undefined;

  return {
    repo,
    file: typeof obj.file === "string" && obj.file.trim() ? obj.file.trim() : undefined,
  };
}

function normalizeProjectEntries(
  parsed: Record<string, unknown>,
): ProjectSettings[] {
  if (!Array.isArray(parsed.projects)) {
    return [];
  }

  return parsed.projects
    .filter((entry): entry is Record<string, unknown> => {
      return Boolean(
        entry
        && typeof entry === "object"
        && !Array.isArray(entry)
        && typeof (entry as { repo?: unknown }).repo === "string"
        && (entry as { repo: string }).repo.trim(),
      );
    })
    .map((entry) => ({
      repo: (entry.repo as string).trim(),
      taskTracker: normalizeInlineTracker(entry.taskTracker),
      createPullRequest:
        typeof entry.createPullRequest === "boolean"
          ? entry.createPullRequest
          : undefined,
    }));
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
  onNonTtyFailure?: () => void,
): Promise<CliName> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    onNonTtyFailure?.();
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
  const githubApp = normalizeGitHubApp(parsed.githubApp, `githubApp in ${filePath}`);

  return {
    defaults: {
      cli: workerCli,
      model:
        typeof defaults.model === "string" && (defaults.model as string).trim()
          ? (defaults.model as string).trim()
          : "gpt-5.4",
      autoModelSelection:
        typeof defaults.autoModelSelection === "boolean"
          ? defaults.autoModelSelection
          : true,
      autoModelSelectionModels: normalizeStringArray(
        defaults.autoModelSelectionModels,
        DEFAULT_CODEX_AUTO_MODEL_SELECTION_MODELS,
      ),
      autoReasoningEffort:
        typeof defaults.autoReasoningEffort === "boolean"
          ? defaults.autoReasoningEffort
          : true,
    },
    assistant: {
      defaults: {
        cli: assistantCli,
      },
    },
    githubApp,
    projects: normalizeProjectEntries(parsed),
  };
}

export function isCreatePullRequestEnabled(
  repoPath: string,
  projects: ProjectSettings[],
): boolean {
  const normalizedRepo = path.resolve(expandHomePath(repoPath));
  for (const project of projects) {
    if (path.resolve(expandHomePath(project.repo)) === normalizedRepo) {
      return project.createPullRequest === true;
    }
  }
  return false;
}

export function persistProjectSettings(
  updates: {
    repo: string;
    createPullRequest?: boolean;
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
        createPullRequest: update.createPullRequest,
      });
      changed = true;
    } else if (
      update.createPullRequest !== undefined &&
      existing.createPullRequest !== update.createPullRequest
    ) {
      existing.createPullRequest = update.createPullRequest;
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
  options?: EnsureCliOptions,
): Promise<CliName> {
  if (current) {
    return current;
  }

  if (options?.preferredCli) {
    persist(options.preferredCli);
    return options.preferredCli;
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

  const promptFn = options?.promptForCli ?? ((choices: CliName[]) => promptForCli(choices, label, settingsKey, options?.onNonTtyFailure));
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
  options?: EnsureCliOptions,
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
  }, {
    ...options,
    onNonTtyFailure: () => {
      const filePath = settingsPath(cfgDir);
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    },
  });
}

/**
 * Ensure assistant.defaults.cli is set. If not, detect/prompt and persist.
 */
export async function ensureAssistantCli(
  settings: WorkersSettings,
  cfgDir = configDir(),
  options?: EnsureCliOptions,
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
  }, {
    ...options,
    onNonTtyFailure: () => {
      const filePath = settingsPath(cfgDir);
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    },
  });
}

/**
 * Check whether any project has a task tracker configured, or whether the
 * WORKERS_TODO_REPO env var provides a fallback.
 */
export function hasTaskTracker(settings: WorkersSettings): boolean {
  if (process.env.WORKERS_TODO_REPO?.trim()) {
    return true;
  }
  return settings.projects.some((project) => project.taskTracker !== undefined);
}

/**
 * When a project has no SPEC.md, prompt the user once to initialize it.
 * The decision is persisted per project so the question is never asked again.
 */
/**
 * Copies SPEC.md, AGENTS.md, and other template files into a newly created
 * project repo.  Only call this for freshly bootstrapped repos.
 */
export function initializeProject(
  repoRoot: string,
  options?: { platform?: NodeJS.Platform },
): void {
  const templateDir = path.join(determinePackageRoot(), "new-project-template");

  if (existsSync(templateDir)) {
    for (const file of readdirSync(templateDir)) {
      copyFileSync(path.join(templateDir, file), path.join(repoRoot, file));
      process.stdout.write(`Created ${file}.\n`);
    }
  }

  const platform = options?.platform ?? os.platform();
  const claudeMdPath = path.join(repoRoot, "CLAUDE.md");
  if (existsSync(path.join(repoRoot, "AGENTS.md")) && !existsSync(claudeMdPath)) {
    if (platform === "win32") {
      copyFileSync(path.join(repoRoot, "AGENTS.md"), claudeMdPath);
    } else {
      symlinkSync("AGENTS.md", claudeMdPath);
    }
  }
}
