import { existsSync } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import type { WorkConfig } from "./types.js";

export function defineConfig(config: WorkConfig): WorkConfig {
  return config;
}

function defaultConfig(repoRoot: string): WorkConfig {
  return {
    projectName: path.basename(repoRoot),
  };
}

export async function loadConfig(repoRoot: string): Promise<WorkConfig> {
  const configPath = path.join(repoRoot, "work.config.ts");
  if (!existsSync(configPath)) {
    return defaultConfig(repoRoot);
  }

  const module = await import(pathToFileURL(configPath).href);
  return module.default ?? defaultConfig(repoRoot);
}
