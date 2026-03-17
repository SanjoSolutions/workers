# workers

A human-first process that supports spontaneity.

## Features

* SPEC.md: A standard for a high-level project spec.
* Coordinator - Workers architecture
  * One coordinator agent prepares tasks for automated workers.
  * Each worker works on one task at a time.
* Multi-project support.
* TODO.md: A lightweight task management system.

## How to

Just start your agent CLI (claude or codex) in this folder and start telling it what you'd like to be built.

In different terminals, start workers (`~/workers/work.sh`). They will pick up tasks, as they become available.

## Prerequisites

* Node.js
* Bash


## Shared TODO Repo

Workers expects the authoritative `TODO.md` to live in a separate git repository.

Configure that repo with environment variables:

```bash
export WORKERS_TODO_REPO="/path/to/shared-todo-repo"
export WORKERS_TODO_FILE="TODO.md"          # optional
export WORKERS_LOCAL_TODO_PATH="TODO.md"    # optional
```

- `WORKERS_TODO_REPO` is required.
- `WORKERS_TODO_FILE` defaults to `TODO.md`.
- `WORKERS_LOCAL_TODO_PATH` defaults to `TODO.md` inside each project worktree.

## Initialize a Shared TODO Repo

Run either command:

```bash
./init-todo-repo.sh
```

or:

```bash
pnpm init-todo-repo
```

The command will:

- ask where to initialize the shared TODO repo
- suggest the current working directory by default
- initialize a git repo there if needed
- create `TODO.md` from `TODO.template.md` if it does not exist
- create an initial commit when it creates the first `TODO.md`
- update `WORKERS_TODO_REPO` in `~/.bashrc` automatically

Example:

```bash
cd ~/my-shared-todos
/path/to/workers/init-todo-repo.sh
```

Then reload your shell config:

```bash
source ~/.bashrc
```

## Add a TODO

To append a new task to `## Planned` in the shared TODO repo, run either command:

```bash
./add-todo.sh "Investigate flaky worker runtime cleanup"
```

or:

```bash
pnpm add-todo "Investigate flaky worker runtime cleanup"
```

You can also pipe multiline markdown into it:

```bash
cat <<'EOF' | ./add-todo.sh
- Investigate flaky worker runtime cleanup
  - Context: Happens after long-running sessions
  - Acceptance: Reused worktrees no longer leave stale runtime state behind
EOF
```

By default, the command writes to `## Planned` in the shared TODO repo configured by
`WORKERS_TODO_REPO`.

If the task is already worker-ready, use `--ready` to place it directly in
`## Ready to be picked up`:

```bash
./add-todo.sh --ready "Fix flaky worker runtime cleanup"
```

## Run Workers

From the workers repo or from any project repo:

```bash
/path/to/workers/work.sh codex
```

or:

```bash
pnpm work codex
```

Workers will:

- sync and claim from the shared TODO repo first
- resolve the claimed task to either a target project repo or a new project repo to bootstrap
- create or reuse a worktree for that resolved repo
- store worktrees under `~/.worktrees/<project>-<hash>/` by default so different repos do not collide
- mirror the authoritative `TODO.md` into the local worktree
- claim TODOs by updating, committing, and pushing the shared TODO repo
- let the agent work in the project repo
- sync TODO completion back to the shared TODO repo
- leave the worker branch/worktree in place by default so the coordinator can review and land it later

Worker-ready task metadata:

- Use `- Repo: /path/to/repo` for normal repo-targeted tasks.
- Use `- Repo: none` for tasks that should run in a scratch workspace instead of any project repo.
- Use `- Type: New project` plus `- Repo: /path/to/new/repo` when workers should bootstrap a new repo first.

## Files in This Repo

- `TODO.template.md`: template for new shared TODO repos
- `SPEC.md`: high-level requirements for workers
- `AGENTS.md`: repo-specific workflow instructions
- `.agents/skills/`: shared agent skills
