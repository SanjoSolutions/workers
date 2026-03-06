export type CliName = "claude" | "codex" | "gemini";

export interface CliOptions {
  cli: CliName;
  worktreeDir: string;
  reuseWorktree: boolean;
  cleanup: boolean;
  cleanupStale: boolean;
  interactive: boolean;
  isolatedRuntime: boolean;
  setupOnly: boolean;
  noTodo: boolean;
  model?: string;
  reasoningEffort?: string;
}

export interface WorktreeInfo {
  path: string;
  branchName: string;
  reuseMode: "new" | "reused";
}

export interface RuntimeInfo {
  cli: CliName;
  hash: string;
  id: string;
  dir: string;
  portSlot: number;
}

export interface AgentEnvContext {
  mode: string;
  todo: string;
  todoType: string;
}

export interface WorkConfig {
  projectName: string;

  /** Called after creating a new worktree (e.g., copy certs, link deps). */
  onWorktreeCreated?: (repoRoot: string, worktreePath: string) => void | Promise<void>;

  agent?: {
    /** Override the full prompt sent to the agent. */
    buildPrompt?: (todo: string, todoType: string) => string;
    /** Claude --allowedTools list. */
    claudeAllowedTools?: string[];
    /** Default claude model (default: "opus"). */
    claudeDefaultModel?: string;
    /** Codex model (default: "o3"). */
    codexModel?: string;
    /** Default codex reasoning effort (default: "high"). */
    codexDefaultReasoning?: string;
    /** Codex --add-dir paths. */
    codexWritableDirs?: string[];
    /** Extra env vars for the agent child process. */
    env?: (ctx: AgentEnvContext) => Record<string, string>;
  };

  runtime?: {
    /** Start isolated services for this worktree. */
    setup: (info: RuntimeInfo, worktreePath: string, repoRoot: string) => Promise<void>;
    /** Stop isolated services for this worktree. */
    stop: (info: RuntimeInfo, worktreePath: string, repoRoot: string) => Promise<void>;
    /** Print runtime status after setup. */
    printStatus?: (info: RuntimeInfo) => void;
  };

  git?: {
    /** Called after a successful rebase (e.g., fix duplicate migrations). */
    afterRebase?: (worktreePath: string) => Promise<void>;
    /** Files to auto-resolve by accepting theirs during rebase (default: ["TODO.md"]). */
    autoResolveFiles?: string[];
  };
}
