# Specification

This document captures the high-level requirements for the workers tool. Update it whenever requirements change or new ones are added. It is the single source of truth for what the system must do.

---

## Principles

- Be respectful.
  - Only ask the user what is required.

## 1. Core Purpose

An optimized process for humans that supports spontaneity, multiple projects and one communication partner.

## OS Support

This project supports Linux, Windows, and Mac OS.

- Automated CI must validate the main test suite on all supported operating systems.
- Packaged `assistant` and `worker` entrypoints must have automated smoke coverage that works without Docker on Mac OS and Windows.

## Agents

### Assistant

The assistant is the communication partner to the human and handles handling the requests of the human efficiently.
This includes delegating bigger work tasks to workers.

### Worker

A worker fulfills one specified task at a time.
Multiple workers can run at the same time.

## Projects

The tool support multiple projects. Projects can have their own task tracker.

## TODO.md repo

- The shared TODO repo is configured via environment variable, not via project config.
- `WORKERS_TODO_REPO` points to the git repository that owns the authoritative `TODO.md`.
- `WORKERS_TODO_FILE` optionally overrides the relative path to the TODO file inside that repo. Default: `TODO.md`.
- `WORKERS_LOCAL_TODO_PATH` optionally overrides the local worktree path for the mirrored TODO file. Default: `TODO.md`.
- Claiming a TODO must update, commit, and push the authoritative TODO file in the shared TODO repo.
- Completing a TODO must update, commit, and push the authoritative TODO file in the shared TODO repo when the agent removes the claimed item from the local copy.

## SPEC.md

SPEC.md captures the high-level requirements for a project.

---

## 2. Multi-Project Workflow

- Workers must be reusable across different project repositories.
- A single shared TODO repository owns the authoritative `TODO.md`.
- Each project repository may have its own worker runtime configuration and isolated worktrees.
- Each worktree keeps a local `TODO.md` copy for agent context, but the source of truth remains the shared TODO repo.
- Workers must also support bootstrap tasks that begin from the shared TODO repo, create a brand new
  target project directory, initialize a git repository there, and then continue in a worker
  worktree for that new project repo.

## 3.1 Task Tracker Abstraction

- Workers must keep task-tracker operations behind an adapter boundary instead of hard-coding the
  runtime directly to the Git-backed `TODO.md` implementation.
- Under `src/task-trackers`, each concrete task tracker implementation must live in its own
  subdirectory.
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
- After larger work is queued, the assistant-local clarification capability under `agents/assistant` remains responsible for refining it into an autonomous task that can move toward `## Ready to be picked up`.
- When the assistant invokes clarification, clarification acts as a temporary nested step and control returns to the assistant afterward.
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
- Each claimed task must run on a fresh dedicated worker branch, even when workers reuse an
  existing worktree path for that repo.
- Claim selection must avoid tasks blocked by dependencies or active conflict-risk annotations.
- Workers must leave completed work on the worker branch/worktree by default.
- Workers must not automatically merge or push worker output back to the tracked branch; the
  assistant is responsible for landing completed work.
- When a project has `createPullRequest: true` in its settings, workers must push the completed
  branch and create a GitHub PR after task completion.
- The PR title must be derived from the TODO item summary.
- The PR body must include the full TODO item text and the list of commits on the branch.
- If the task originated from a GitHub issue, the PR body must reference it with `Closes #N`.
- PR creation is skipped silently when the branch has no commits or has no GitHub remote.

## 7. Agent Support

- Workers supports Claude Code CLI, Codex CLI, and Gemini CLI.
- Shared skills can live under `.agents/skills`.
- Clarification must remain an assistant-only capability under `agents/assistant/.agents/skills/clarification`.
- `.claude/skills` may point to the shared skills location.
- Agent instructions must make clear when TODO synchronization is handled by the workers runtime rather than by the project repo commit.
- When no explicit model is specified (via TODO metadata, CLI flag, or project config), the Claude
  strategy must auto-evaluate the best model by calling `claude --model opus` to classify the task
  as haiku, sonnet, or opus. The evaluation must fall back to sonnet on failure.
- When the worker CLI is Codex and no explicit model is specified (via TODO metadata, CLI flag, or
  project config), the strategy must auto-evaluate the best model when
  `worker.defaults.autoModelSelection` is enabled. The candidate model list must come from
  `worker.defaults.autoModelSelectionModels`, defaulting to `gpt-5.4`, `gpt-5.4-mini`, and
  `gpt-5.3-codex`.
- When the worker CLI is Codex and no explicit reasoning effort is specified (via TODO metadata,
  CLI flag, or project config), the strategy must auto-evaluate the best reasoning effort when
  `worker.defaults.autoReasoningEffort` is enabled. The evaluation must fall back to `high` on
  failure.
- When the worker CLI is Codex, workers must load the selected worker system prompt through Codex
  `model_instructions_file` instead of inlining that prompt into the user task prompt.
- Workers must provide one worker system prompt template at `agents/worker/SYSTEM.md`.
- Agent system prompt templates must support including other Markdown files with paths resolved
  relative to the including file.
- Agent system prompt templates must remain task-tracker-neutral and must not assume the claimed
  task came from one specific task tracker backend.
- The Codex worker system prompt must instruct the worker to operate as autonomously as possible
  while still allowing user input requests when the worker is genuinely blocked.

## 8. Runtime Hooks

- Project-specific runtime setup and teardown may still be configured per repo.
- Project-specific worktree hooks may still be configured per repo.
- Shared TODO ownership must not depend on repo-local config files.
- Managed interactive worker sessions must record live session metadata and clear stale running status on exit, error, or interruption.

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
- Codex auto model selection must be configurable through this settings file, including the list of
  candidate models to consider.
- Codex auto reasoning effort selection must be configurable through this settings file.
- The default task tracker must be configurable through this settings file.
- Workers settings must support one shared `githubApp` configuration with `appId` and
  `privateKeyPath`.
- When configured, the shared `githubApp` must provide GitHub authentication for both task tracker
  operations and launched agent sessions.
- Invalid shared `githubApp` configuration in settings must fail with a clear error instead of being
  ignored silently.
- Settings must support named task trackers and project-to-task-tracker assignments.
- Project registrations in settings must be stored as an ordered array, and worker polling must
  follow that order from first project to last.
- Projects must be added to settings automatically when they are first mentioned or bootstrapped.
- The assistant intake flow must route queued work to the configured task tracker for the target
  project, falling back to the default task tracker when the project has no explicit assignment.
- Workers must not persist a default Codex reasoning level value in settings; TODO metadata may
  specify `Reasoning`, auto reasoning effort may be enabled in settings, and the runtime fallback
  remains `high` when no explicit or auto-selected value is available.

## 8.2 Task Tracker Routing

- Workers must support more than one task tracker configuration at a time.
- A project may optionally declare which task tracker owns its queued work.
- Tasks with `Repo: none` or tasks for unmapped projects must use the default task tracker.
- Workers must support both the Git-backed `TODO.md` tracker and GitHub Issues as concrete task
  tracker backends.
- When workers clarify or queue work against an existing GitHub issue, they must preserve the
  user-authored issue title and body instead of overwriting them.
- Worker-authored normalized task specifications for GitHub Issues must be stored in a structured
  worker comment format that can be identified and parsed without inspecting unrelated discussion
  comments.
- GitHub Issues claim, listing, and execution flows must derive worker metadata from the latest
  structured worker task-spec comment, defaulting to new comments for updates and allowing edits
  only when correcting a recent unresponded worker comment.
- When a GitHub Issues-backed task finishes in a worker, workers must leave the issue open so the
  merged pull request can close it through the repository's auto-close flow.
- When workers create a pull request for a GitHub Issues-backed task, they must move the issue out
  of `workers:in-progress` and into `workers:pr-ready`.
- When a GitHub Issues-backed task is closed by merge or otherwise closed, workers or repository
  automation must remove workflow labels from the issue.
- In GitHub Issues trackers, unlabeled open issues must be treated as planned or backlog work, and
  `workers:ready-to-be-picked-up`, `workers:in-progress`, and `workers:pr-ready` are the
  operational workflow labels.
- In GitHub Issues trackers, claiming a ready issue must add a worker-authored claim comment that
  begins with a human-readable message and also includes structured claim metadata for machine
  parsing.
- The human-readable GitHub issue claim comment message must be configurable per tracker, with a
  sensible default.
- Concurrent GitHub issue claim attempts must resolve deterministically so only one worker keeps the
  claim and losing workers continue polling without crashing.
- Tracker selection and worker polling must no longer be hard-coded to a single repository.

## 8.3 Assistant Command

- Workers must provide an `assistant` command that launches an interactive agent session in the
  workers repo directory.
- The assistant command must use the workers repo's `AGENTS.md` and related configuration.
- The assistant CLI is configurable via `assistant.defaults.cli` in settings, falling back to
  `worker.defaults.cli`.
- The shared assistant system prompt used across supported assistant CLIs must be
  `agents/assistant/SYSTEM.md`.
- `agents/assistant/SYSTEM.md` must be treated as a template source and preprocessed before it is
  passed to an assistant CLI.
- The assistant system prompt template must support CLI-specific conditional blocks so each
  supported assistant CLI receives only the instructions that apply to it.
- The assistant system prompt template must support including other Markdown files with paths
  resolved relative to the including file.
- `agents/assistant/SYSTEM.md` must use the upstream Codex base instructions from
  `codex-rs/protocol/src/prompts/base_instructions/default.md` as its foundation.
- `agents/assistant/SYSTEM.md` may add assistant-specific workers coordination instructions in the
  same file, including startup branch checks, larger-task queueing, clarification, and task-status
  handling behavior.

## 8.4 Branch Status Reporting

- `list-todos --branches` must cross-reference all `work/*` worktree branches across configured
  project repos against in-progress TODOs in all configured task trackers.
- A branch is **finished** when its local `TODO.md` lists an in-progress item that no longer
  appears in the shared tracker's in-progress section (i.e., the worker completed that task).
- A branch is **in-progress** when its local `TODO.md` in-progress item still exists in the
  tracker's current in-progress section.
- A branch is **unknown** when no local `TODO.md` is found in its worktree.
- The assistant must run `list-todos --branches` at the start of every new conversation and
  proactively present any finished branches to the user with a merge suggestion.

## 10. Verification

- TypeScript changes must typecheck with `npx tsc --noEmit`.
- Workers must provide a separate on-demand CLI feature test suite that verifies the exact CLI
  features and invocation patterns used by workers for each supported agent CLI.
- The on-demand CLI feature test suite is intended to be run when installing or updating an agent
  CLI and must not be part of the default automated test run.
- Publishable/runtime entrypoints must be compiled JavaScript under `build/` rather than relying on
  `tsx` at runtime.
- Repo-facing POSIX shell compatibility wrappers must pass `sh -n`.

## 11. License Compliance

- When repository guidance or documentation copies or adapts substantive text from another project,
  workers must retain clear provenance in the edited file or adjacent docs.
- Workers must include the applicable third-party notice and required license text in the repo when
  that copied text remains.
