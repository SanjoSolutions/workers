import { spawn } from "child_process";
import path from "path";
import type { AgentResult } from "./types.js";

interface SpawnAgentProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  captureOutput: boolean;
}

const WINDOWS_SHELL_COMMANDS = new Set(["claude", "codex", "gemini", "pi"]);

export function shouldUseWindowsCommandShell(command: string): boolean {
  if (process.platform !== "win32") {
    return false;
  }

  const commandName = path.basename(command).toLowerCase();
  return WINDOWS_SHELL_COMMANDS.has(commandName) || commandName.endsWith(".cmd") || commandName.endsWith(".bat");
}

export async function spawnAgentProcess(
  options: SpawnAgentProcessOptions,
): Promise<AgentResult> {
  return new Promise<AgentResult>((resolve) => {
    let output = "";

    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      shell: shouldUseWindowsCommandShell(options.command),
      stdio: options.captureOutput
        ? ["inherit", "pipe", "pipe"]
        : ["inherit", "inherit", "inherit"],
    });

    if (options.captureOutput) {
      child.stdout?.on("data", (data: Buffer) => {
        output += data.toString();
      });
      child.stderr?.on("data", (data: Buffer) => {
        output += data.toString();
      });
    }

    child.on("close", (code) => {
      if (options.captureOutput && output) {
        console.log(output);
      }
      resolve({
        exitCode: code ?? 1,
        output,
      });
    });

    child.on("error", (error) => {
      resolve({
        exitCode: 1,
        output: error.message,
      });
    });
  });
}
