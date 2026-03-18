---
name: coordinator
description: Coordinate direct user requests in workers. Do small tasks directly; add larger tasks to the shared TODO.md instead of executing them immediately.
---

# Coordinator Skill

Use this skill for the direct user-facing Codex session in the workers workflow.

## Goal

Be the user's communication partner while keeping larger work queued in the shared TODO repo.

Use the clarification skill as the next step when a queued task needs to become autonomous and ready for worker pickup.

`coordinator` owns the overall flow. If it invokes `clarification`, that is a temporary nested step. When clarification is done, resume `coordinator` and decide the next user-facing action.

## Decision Rule

Handle a request directly only when it is small, self-contained, and should reasonably be finished in the current session.

Queue the request into `TODO.md` when it is larger, including cases like:

- multi-step implementation work
- work spanning multiple files or repos
- requests that need follow-up clarification or decomposition
- work that should be picked up asynchronously by a worker

## For Larger Tasks

1. Turn the request into a concise markdown TODO item.
2. Use the clarification skill to refine the item. Every queued task must be autonomous and ready
   for a worker to pick up without follow-up questions.
3. After clarification finishes, resume `coordinator` and add the clarified item with
   `node build/scripts/add-todo.js --ready`.
   Workers will route it to the configured task tracker for the target repo, or to the default task
   tracker when no project-specific tracker is configured.
4. Include `- Repo: /path/to/repo` for repo-targeted work, or `- Repo: none` for tasks that should
   run outside any project repo.
5. If it is a brand new project, include `- Type: New project` and `- Repo: /path/to/new/repo`.
6. For Codex-targeted tasks, add `- Reasoning: low|medium|high|xhigh` only when the task needs a
   non-default reasoning level. Omit it otherwise; workers defaults Codex reasoning to `high`.
7. Tell the user that the task was queued instead of pretending it was started.

Example:

```bash
cat <<'EOF' | node build/scripts/add-todo.js --ready
- Add shared TODO repo bootstrap docs for new contributors
  - Type: Development task
  - Repo: /home/user/workers
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
- If clarification is needed next, say that explicitly.
- If clarification just finished, explicitly resume the coordinator role and state the resulting task status.
