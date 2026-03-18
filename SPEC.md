# Specification

This document captures the high-level requirements for the workers tool. Update it whenever requirements change or new ones are added. It is the single source of truth for what the system must do.

---

## Principles

- Be respectful.
  - Only ask the user what is required.

## 1. Core Purpose

Workers orchestrates isolated development work for AI coding agents across multiple project repositories.

## 2. Multi-Project Workflow

- Workers must be reusable across different project repositories.
- A single shared TODO repository owns the authoritative `TODO.md`.
- Each project repository may have its own worker runtime configuration and isolated worktrees.
- Each worktree keeps a local `TODO.md` copy for agent context, but the source of truth remains the shared TODO repo.
- Workers must also support bootstrap tasks that begin from the shared TODO repo, create a brand new
  target project directory, initialize a git repository there, and then continue in a worker
  worktree for that new project repo.

## 3. Shared TODO Repository

- The shared TODO repo is configured via environment variable, not via project config.
- `WORKERS_TODO_REPO` points to the git repository that owns the authoritative `TODO.md`.
- `WORKERS_TODO_FILE` optionally overrides the relative path to the TODO file inside that repo. Default: `TODO.md`.
- `WORKERS_LOCAL_TODO_PATH` optionally overrides the local worktree path for the mirrored TODO file. Default: `TODO.md`.
- Claiming a TODO must update, commit, and push the authoritative TODO file in the shared TODO repo.
- Completing a TODO must update, commit, and push the authoritative TODO file in the shared TODO repo when the agent removes the claimed item from the local copy.

## 3.1 Task Tracker Abstraction

- Workers must keep task-tracker operations behind an adapter boundary instead of hard-coding the
  runtime directly to the Git-backed `TODO.md` implementation.
- The current shared `TODO.md` git repo is the first backend implementation.
- Future backends such as GitHub Issues or Jira must be addable without rewriting the worker
  orchestration flow.
- Claim, sync, completion, and task-selection operations must be expressible through this backend
  abstraction.

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
- The TODO intake command must also support explicitly placing already-autonomous tasks into
  `## Ready to be picked up`.
- This intake command is intended for a direct user-facing Codex session that captures bigger tasks instead of attempting them immediately.
- The intake command must use the shared TODO repo configured via environment variable.
- Workers must also provide a shared intake skill for the direct user-facing Codex session so this behavior can be applied by default.
- After larger work is queued, the clarification skill remains responsible for refining it into an autonomous task that can move toward `## Ready to be picked up`.
- When the coordinator skill invokes clarification, clarification acts as a temporary nested step and control returns to coordinator afterward.
- Package installation must expose `assistant` and `worker` as Node bin commands.
- Ready-to-pick-up tasks must record their target repo in structured task metadata.
- Tasks that are not for any repo must record that explicitly as `Repo: none`.
- New-project tasks must record the target repo path in structured task metadata.

## 5. TODO Template

- `TODO.template.md` is committed in the workers repo and defines the default section layout for new shared TODO repos.
- Local `TODO.md` files in the workers repo itself must not be committed.

## 6. Worktree Execution

- Each worker run must first synchronize and claim from the shared TODO repo before deciding whether
  a target project repo and worktree are needed.
- Repo selection happens after claim resolution:
  existing target repo, explicit no-repo scratch workspace, or newly bootstrapped target repo.
- When a claimed task targets an existing project repo, the worker run executes in a dedicated git
  worktree for that target project repo.
- When a claimed task sets `Repo: none`, workers must provision a scratch workspace that is not tied
  to any project repo.
- When a claimed task is `Type: New project`, workers must bootstrap the target repo first and then
  create the worker worktree from that newly initialized repo.
- By default, worker worktrees live outside the project checkout under `~/.worktrees`.
- The default external worktree layout must namespace each project to avoid collisions between repos
  that share the same directory name.
- Reused worktrees must be synced with the latest project repository state before agent work starts.
- Claim selection must avoid tasks blocked by dependencies or active conflict-risk annotations.
- Workers must leave completed work on the worker branch/worktree by default.
- Workers must not automatically merge or push worker output back to the tracked branch; the
  coordinator is responsible for landing completed work.
- When a project has `createPullRequest: true` in its settings, workers must push the completed
  branch and create a GitHub PR after task completion.
- The PR title must be derived from the TODO item summary.
- The PR body must include the full TODO item text and the list of commits on the branch.
- If the task originated from a GitHub issue, the PR body must reference it with `Closes #N`.
- PR creation is skipped silently when the branch has no commits or has no GitHub remote.

## 7. Agent Support

- Workers supports Claude Code CLI, Codex CLI, and Gemini CLI.
- Shared skills can live under `.agents/skills`.
- `.claude/skills` may point to the shared skills location.
- Agent instructions must make clear when TODO synchronization is handled by the workers runtime rather than by the project repo commit.
- When no explicit model is specified (via TODO metadata, CLI flag, or project config), the Claude
  strategy must auto-evaluate the best model by calling `claude --model opus` to classify the task
  as haiku, sonnet, or opus. The evaluation must fall back to sonnet on failure.

## 8. Runtime Hooks

- Project-specific runtime setup and teardown may still be configured per repo.
- Project-specific worktree hooks may still be configured per repo.
- Shared TODO ownership must not depend on repo-local config files.

## 8.1 Workers Settings

- Workers must store user-editable settings in a platform-appropriate config directory:
  - Linux: `$XDG_CONFIG_HOME/workers/` (default `~/.config/workers/`)
  - macOS: `~/Library/Application Support/workers/`
  - Windows: `%APPDATA%\workers\`
  - Override: `WORKERS_CONFIG_DIR` environment variable
- `settings.template.json` must be committed in the package as the template for new settings files.
- If `settings.json` does not exist in the config directory, workers must create it by copying
  `settings.template.json` before loading settings.
- If settings initialization fails (e.g. CLI auto-detection cannot prompt), the partially created
  settings file must be removed to avoid leaving broken state.
- Initial settings creation must choose `worker.defaults.cli` automatically when exactly one
  supported worker CLI is installed.
- Initial settings creation must prompt the user to choose `worker.defaults.cli` when multiple
  supported worker CLIs are installed.
- After `settings.json` exists, workers must read it as the source of truth instead of prompting
  again.
- Default CLI selection must be configurable through this settings file.
- The default agent model must be configurable through this settings file.
- The default task tracker must be configurable through this settings file.
- Settings must support named task trackers and project-to-task-tracker assignments.
- Project registrations in settings must be stored as an ordered array, and worker polling must
  follow that order from first project to last.
- Projects must be added to settings automatically when they are first mentioned or bootstrapped.
- The coordinator intake flow must route queued work to the configured task tracker for the target
  project, falling back to the default task tracker when the project has no explicit assignment.
- Workers must not persist a default Codex reasoning level in settings; TODO metadata may specify
  `Reasoning`, and the runtime fallback remains `high` when it is omitted.

## 8.2 Task Tracker Routing

- Workers must support more than one task tracker configuration at a time.
- A project may optionally declare which task tracker owns its queued work.
- Tasks with `Repo: none` or tasks for unmapped projects must use the default task tracker.
- Workers must support both the Git-backed `TODO.md` tracker and GitHub Issues as concrete task
  tracker backends.
- Tracker selection and worker polling must no longer be hard-coded to a single repository.

## 8.3 Assistant Command

- Workers must provide an `assistant` command that launches an interactive agent session in the
  workers repo directory.
- The assistant command must use the workers repo's `AGENTS.md` and related configuration.
- The assistant CLI is configurable via `assistant.defaults.cli` in settings, falling back to
  `worker.defaults.cli`.

## 8.4 Branch Status Reporting

- `list-todos --branches` must cross-reference all `work/*` worktree branches across configured
  project repos against in-progress TODOs in all configured task trackers.
- A branch is **finished** when its local `TODO.md` lists an in-progress item that no longer
  appears in the shared tracker's in-progress section (i.e., the worker completed that task).
- A branch is **in-progress** when its local `TODO.md` in-progress item still exists in the
  tracker's current in-progress section.
- A branch is **unknown** when no local `TODO.md` is found in its worktree.
- The coordinator must run `list-todos --branches` at the start of every new conversation and
  proactively present any finished branches to the user with a merge suggestion.

## 9. Platform Support

- Workers must support Linux, Windows, and macOS.

## 10. Verification

- TypeScript changes must typecheck with `npx tsc --noEmit`.
- Publishable/runtime entrypoints must be compiled JavaScript under `build/` rather than relying on
  `tsx` at runtime.
- Repo-facing POSIX shell compatibility wrappers must pass `sh -n`.

## 11. License Compliance

- When repository guidance or documentation copies or adapts substantive text from another project,
  workers must retain clear provenance in the edited file or adjacent docs.
- Workers must include the applicable third-party notice and required license text in the repo when
  that copied text remains.
