import { copyFileSync, existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { CliName } from "./types.js";

const VALID_CLIS = new Set<CliName>(["claude", "codex", "gemini"]);

export interface WorkersSettings {
  defaultCli: CliName;
}

const DEFAULT_SETTINGS: WorkersSettings = {
  defaultCli: "codex",
};

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

function ensureSettingsFile(repoRoot = workersRepoRoot()): string {
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
  return filePath;
}

export function loadSettings(repoRoot = workersRepoRoot()): WorkersSettings {
  const filePath = ensureSettingsFile(repoRoot);

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

  const defaultCli = (parsed as { defaultCli?: unknown }).defaultCli;
  if (defaultCli === undefined) {
    return DEFAULT_SETTINGS;
  }
  if (typeof defaultCli !== "string" || !VALID_CLIS.has(defaultCli as CliName)) {
    throw new Error(
      `Invalid settings in ${filePath}: defaultCli must be one of claude, codex, gemini.`,
    );
  }

  return {
    defaultCli: defaultCli as CliName,
  };
}
