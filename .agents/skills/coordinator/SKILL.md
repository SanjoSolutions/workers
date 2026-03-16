---
name: coordinator
description: Coordinate direct user requests in workers. Do small tasks directly; add larger tasks to the shared TODO.md instead of executing them immediately.
---

# Coordinator Skill

Use this skill for the direct user-facing Codex session in the workers workflow.

## Goal

Be the user's communication partner while keeping larger work queued in the shared TODO repo.

## Decision Rule

Handle a request directly only when it is small, self-contained, and should reasonably be finished in the current session.

Queue the request into `TODO.md` when it is larger, including cases like:

- multi-step implementation work
- work spanning multiple files or repos
- requests that need follow-up clarification or decomposition
- work that should be picked up asynchronously by a worker

## For Larger Tasks

1. Turn the request into a concise markdown TODO item for `## Planned`.
2. Include useful context or acceptance bullets when they are already clear.
3. Add it with `./add-todo.sh` so it lands in the shared TODO repo.
4. Tell the user that the task was queued instead of pretending it was started.

Example:

```bash
cat <<'EOF' | ./add-todo.sh
- Add shared TODO repo bootstrap docs for new contributors
  - Context: README should explain init flow and required env vars
  - Acceptance: A new contributor can initialize and configure the shared TODO repo without extra guidance
EOF
```

## For Small Tasks

- Do the work directly.
- Do not create a TODO just for busywork.

## Output Style

- Be explicit whether you handled the task now or queued it.
- If queued, summarize the TODO you added.
