# workers

Workers orchestrates isolated AI-agent work across multiple project repositories while using one shared TODO repository as the source of truth.

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

## Run Workers

From a project repository:

```bash
/path/to/workers/work.sh codex
```

or:

```bash
pnpm work codex
```

Workers will:

- create or reuse a project worktree
- sync the shared TODO repo
- mirror the authoritative `TODO.md` into the local worktree
- claim TODOs by updating, committing, and pushing the shared TODO repo
- let the agent work in the project repo
- sync TODO completion back to the shared TODO repo

## Files in This Repo

- `TODO.template.md`: template for new shared TODO repos
- `SPEC.md`: high-level requirements for workers
- `AGENTS.md`: repo-specific workflow instructions
- `.agents/skills/`: shared agent skills
