import type { CliName } from "../types.js";
import type { AgentStrategy } from "./types.js";
import { ClaudeAgentStrategy } from "./claude/index.js";
import { CodexAgentStrategy } from "./codex/index.js";
import { GeminiAgentStrategy } from "./gemini/index.js";
import { PiAgentStrategy } from "./pi/index.js";

const STRATEGIES: Record<CliName, AgentStrategy> = {
  claude: new ClaudeAgentStrategy(),
  codex: new CodexAgentStrategy(),
  gemini: new GeminiAgentStrategy(),
  pi: new PiAgentStrategy(),
};

export function getAgentStrategy(cli: CliName): AgentStrategy {
  return STRATEGIES[cli];
}
