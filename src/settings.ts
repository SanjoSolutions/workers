import { copyFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import readline from "readline/promises";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import type { CliName } from "./types.js";

const VALID_CLIS: CliName[] = ["claude", "codex", "gemini"];
const VALID_CLI_SET = new Set<CliName>(VALID_CLIS);

export interface WorkersSettings {
  defaultCli: CliName;
  codexModel: string;
  defaultTaskTracker: string | undefined;
  taskTrackers: Record<string, GitTodoTaskTrackerSettings>;
  projects: Record<string, ProjectTaskTrackerSettings>;
}

export interface GitTodoTaskTrackerSettings {
  repo: string;
  file?: string;
}

export interface ProjectTaskTrackerSettings {
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

function detectInstalledClis(env: NodeJS.ProcessEnv): CliName[] {
  return VALID_CLIS.filter((cli) => {
    const result = spawnSync("/bin/bash", ["-c", `command -v ${cli} >/dev/null 2>&1`], {
      env,
      stdio: "ignore",
    });
    return result.status === 0;
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
    codexModel:
      typeof parsed.codexModel === "string" && parsed.codexModel.trim()
        ? parsed.codexModel.trim()
        : "gpt-5.4",
    defaultTaskTracker:
      typeof parsed.defaultTaskTracker === "string" && parsed.defaultTaskTracker.trim()
        ? parsed.defaultTaskTracker.trim()
        : undefined,
    taskTrackers:
      parsed.taskTrackers && typeof parsed.taskTrackers === "object" && !Array.isArray(parsed.taskTrackers)
        ? (parsed.taskTrackers as Record<string, GitTodoTaskTrackerSettings>)
        : {},
    projects:
      parsed.projects && typeof parsed.projects === "object" && !Array.isArray(parsed.projects)
        ? (parsed.projects as Record<string, ProjectTaskTrackerSettings>)
        : {},
  };
}
