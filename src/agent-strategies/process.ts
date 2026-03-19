import { spawn } from "child_process";
import type { AgentResult } from "./types.js";

interface SpawnAgentProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  captureOutput: boolean;
}

export async function spawnAgentProcess(
  options: SpawnAgentProcessOptions,
): Promise<AgentResult> {
  return new Promise<AgentResult>((resolve) => {
    let output = "";

    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      shell: process.platform === "win32",
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
