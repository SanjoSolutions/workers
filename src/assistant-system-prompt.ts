import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import os from "os";
import path from "path";
import type { CliName } from "./types.js";

const CLI_BLOCK_PATTERN = /{{#cli\s+([^}]+)}}([\s\S]*?){{\/cli}}/g;

export function renderAssistantSystemPromptTemplate(
  template: string,
  cli: CliName,
): string {
  return template.replace(CLI_BLOCK_PATTERN, (_match, rawCliNames: string, block: string) => {
    const cliNames = rawCliNames
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    return cliNames.includes(cli) ? block : "";
  });
}

export interface PreparedAssistantSystemPrompt {
  cleanup: () => void;
  content: string;
  filePath: string;
}

function assistantSystemPromptCacheDir(): string {
  const cacheDir = path.join(os.tmpdir(), "workers-assistant-system-prompt-cache");
  mkdirSync(cacheDir, { recursive: true });
  return cacheDir;
}

export function prepareAssistantSystemPrompt(
  systemPromptTemplatePath: string,
  cli: CliName,
): PreparedAssistantSystemPrompt {
  const template = readFileSync(systemPromptTemplatePath, "utf8");
  const rendered = renderAssistantSystemPromptTemplate(template, cli);
  const extension = path.extname(systemPromptTemplatePath);
  const baseName = path.basename(systemPromptTemplatePath, extension);
  const cacheKey = createHash("sha256")
    .update(JSON.stringify({
      cli,
      rendered,
      systemPromptTemplatePath: path.resolve(systemPromptTemplatePath),
    }))
    .digest("hex")
    .slice(0, 16);
  const filePath = path.join(
    assistantSystemPromptCacheDir(),
    `${baseName}.${cli}.${cacheKey}${extension}`,
  );

  if (!existsSync(filePath)) {
    writeFileSync(filePath, rendered, "utf8");
  }

  return {
    cleanup: () => {},
    content: rendered,
    filePath,
  };
}
