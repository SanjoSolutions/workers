# Specification

This document captures the high-level requirements for the workers tool. Update it whenever requirements change or new ones are added. It is the single source of truth for what the system must do.

---

## 1. Core Purpose

Workers orchestrates isolated development work for AI coding agents across multiple project repositories.

## 2. Multi-Project Workflow

- Workers must be reusable across different project repositories.
- A single shared TODO repository owns the authoritative `TODO.md`.
- Each project repository may have its own worker runtime configuration and isolated worktrees.
- Each worktree keeps a local `TODO.md` copy for agent context, but the source of truth remains the shared TODO repo.

## 3. Shared TODO Repository

- The shared TODO repo is configured via environment variable, not via project config.
- `WORKERS_TODO_REPO` points to the git repository that owns the authoritative `TODO.md`.
- `WORKERS_TODO_FILE` optionally overrides the relative path to the TODO file inside that repo. Default: `TODO.md`.
- `WORKERS_LOCAL_TODO_PATH` optionally overrides the local worktree path for the mirrored TODO file. Default: `TODO.md`.
- Claiming a TODO must update, commit, and push the authoritative TODO file in the shared TODO repo.
- Completing a TODO must update, commit, and push the authoritative TODO file in the shared TODO repo when the agent removes the claimed item from the local copy.

## 4. TODO Repo Initialization

- Workers must provide a command to initialize a shared TODO repo from the checked-in template.
- The init command must ask where to initialize the repo.
- The suggested default location is the current working directory.
- If the target directory is not yet a git repo, the command must initialize one.
- If `TODO.md` does not exist, the command must create it from `TODO.template.md`.
- The init command should create an initial commit when it creates the first `TODO.md`.
- The init command must update `WORKERS_TODO_REPO` in `~/.bashrc` automatically.

## 4.1 TODO Intake

- Workers must provide a command to append new queued work to `## Planned` in the shared TODO repo.
- This intake command is intended for a direct user-facing Codex session that captures bigger tasks instead of attempting them immediately.
- The intake command must use the shared TODO repo configured via environment variable.
- Workers must also provide a shared intake skill for the direct user-facing Codex session so this behavior can be applied by default.

## 5. TODO Template

- `TODO.template.md` is committed in the workers repo and defines the default section layout for new shared TODO repos.
- Local `TODO.md` files in the workers repo itself must not be committed.

## 6. Worktree Execution

- Each worker run executes in a dedicated git worktree for the target project repo.
- Reused worktrees must be synced with the latest project repository state before agent work starts.
- Claim selection must avoid tasks blocked by dependencies or active conflict-risk annotations.

## 7. Agent Support

- Workers supports Claude Code CLI, Codex CLI, and Gemini CLI.
- Shared skills can live under `.agents/skills`.
- `.claude/skills` may point to the shared skills location.
- Agent instructions must make clear when TODO synchronization is handled by the workers runtime rather than by the project repo commit.

## 8. Runtime Hooks

- Project-specific runtime setup and teardown may still be configured per repo.
- Project-specific worktree hooks may still be configured per repo.
- Shared TODO ownership must not depend on repo-local config files.

## 9. Verification

- TypeScript changes must typecheck with `npx tsc --noEmit`.
- Repo-facing shell wrappers must pass `bash -n`.
