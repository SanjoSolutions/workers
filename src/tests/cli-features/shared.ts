import { spawnSync, type SpawnSyncReturns } from "child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import type { CliName } from "../../types.js";
import { prepareSystemPrompt } from "../../assistant-system-prompt.js";

export const featureCheckPrompt = "What is the configured feature check response?";
export const featureCheckResponse = "FEATURE_CHECK_OK";

function runCommandOrThrow(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
  });

  if (result.status === 0) {
    return;
  }

  const output = (result.stdout ?? "") + (result.stderr ?? "");
  throw new Error(
    [
      `Command failed: ${command} ${args.join(" ")}`,
      output.trim(),
    ].filter(Boolean).join("\n"),
  );
}

export function createTemporaryProject(prefix: string): string {
  const projectPath = mkdtempSync(path.join(tmpdir(), prefix));

  mkdirSync(projectPath, { recursive: true });
  runCommandOrThrow("git", ["init", "-b", "main"], projectPath);
  runCommandOrThrow("git", ["config", "user.name", "Test"], projectPath);
  runCommandOrThrow("git", ["config", "user.email", "test@test"], projectPath);
  runCommandOrThrow("git", ["commit", "--allow-empty", "-m", "initialize repository"], projectPath);

  return projectPath;
}

export function prepareFeatureCheckSystemPrompt(cli: CliName) {
  const promptRoot = mkdtempSync(path.join(tmpdir(), `workers-cli-feature-${cli}-`));
  const systemPromptPath = path.join(promptRoot, "SYSTEM.md");

  writeFileSync(
    systemPromptPath,
    [
      "You are running a CLI feature check.",
      `When the user asks "${featureCheckPrompt}", reply with exactly ${featureCheckResponse}.`,
      "Do not add any other text.",
    ].join("\n"),
    "utf8",
  );

  return prepareSystemPrompt(systemPromptPath, cli);
}

export function assertFeatureCheckSucceeded(
  result: SpawnSyncReturns<string>,
  cliName: string,
): void {
  const output = (result.stdout ?? "") + (result.stderr ?? "");

  console.log(`${cliName} output:`);
  console.log(output);

  if (result.status !== 0) {
    throw new Error(`${cliName} exited with status ${result.status}`);
  }

  if (!output.includes(featureCheckResponse)) {
    throw new Error(
      `${cliName} did not return the expected feature check response "${featureCheckResponse}".`,
    );
  }
}
