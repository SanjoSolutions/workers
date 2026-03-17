import type { AgentStrategy } from "./types.js";
import { spawnAgentProcess } from "./process.js";

export class GeminiAgentStrategy implements AgentStrategy {
  readonly cli = "gemini" as const;

  async launch(context: Parameters<AgentStrategy["launch"]>[0]) {
    const args = context.noTodo
      ? ["--approval-mode", "auto_edit"]
      : ["--prompt", context.nextPrompt, "--approval-mode", "auto_edit"];

    return spawnAgentProcess({
      command: "gemini",
      args,
      cwd: context.worktreePath,
      env: context.env,
      captureOutput: !context.options.interactive,
    });
  }
}
