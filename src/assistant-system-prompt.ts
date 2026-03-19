import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import os from "os";
import path from "path";
import type { CliName } from "./types.js";

const CLI_BLOCK_PATTERN = /{{#cli\s+([^}]+)}}([\s\S]*?){{\/cli}}/g;
const INCLUDE_PATTERN = /{{\s*include\s+([^}\s][^}]*)\s*}}/g;
const LEADING_SOURCE_ONLY_COMMENT_PATTERN = /^(?:\s*<!--[\s\S]*?-->\s*)+/;

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

export const renderSystemPromptTemplate = renderAssistantSystemPromptTemplate;

function renderAssistantSystemPromptFile(
  filePath: string,
  cli: CliName,
  activeStack: string[],
): string {
  const resolvedPath = path.resolve(filePath);

  if (activeStack.includes(resolvedPath)) {
    const cycle = [...activeStack, resolvedPath].join(" -> ");
    throw new Error(`SYSTEM.md include cycle detected: ${cycle}`);
  }

  const template = readFileSync(resolvedPath, "utf8");
  const renderedTemplate = renderAssistantSystemPromptTemplate(template, cli);

  return renderedTemplate.replace(INCLUDE_PATTERN, (_match, rawIncludePath: string) => {
    const includePath = rawIncludePath.trim();
    const resolvedIncludePath = path.resolve(path.dirname(resolvedPath), includePath);
    return renderAssistantSystemPromptFile(
      resolvedIncludePath,
      cli,
      [...activeStack, resolvedPath],
    );
  });
}

export interface PreparedAssistantSystemPrompt {
  cleanup: () => void;
  content: string;
  filePath: string;
}

function assistantSystemPromptCacheDir(): string {
  const cacheDir = path.join(os.tmpdir(), "workers-system-prompt-cache");
  mkdirSync(cacheDir, { recursive: true });
  return cacheDir;
}

function stripLeadingSourceOnlyComments(content: string): string {
  return content.replace(LEADING_SOURCE_ONLY_COMMENT_PATTERN, "");
}

export function prepareAssistantSystemPrompt(
  systemPromptTemplatePath: string,
  cli: CliName,
): PreparedAssistantSystemPrompt {
  const rendered = stripLeadingSourceOnlyComments(
    renderAssistantSystemPromptFile(systemPromptTemplatePath, cli, []),
  );
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

export const prepareSystemPrompt = prepareAssistantSystemPrompt;
