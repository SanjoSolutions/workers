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
2. Put it in `## Planned` by default.
3. If the task is already autonomous and safe for a worker to start immediately, add it straight to
   `## Ready to be picked up` with `./add-todo.sh --ready`.
4. Include useful context or acceptance bullets when they are already clear.
5. If the task targets another repo, include `- Repo: /path/to/repo`.
6. If it is a brand new project, include `- Type: New project` and `- Repo: /path/to/new/repo`.
7. Add it with `./add-todo.sh` so it lands in the shared TODO repo.
8. Tell the user that the task was queued instead of pretending it was started.

If the queued task is too ambiguous for a worker to execute safely:

9. Use the clarification skill to ask the missing questions and promote it toward `## Ready to be picked up`.
10. After clarification finishes, return to `coordinator`.
11. Tell the user whether the task is now ready for worker pickup or still remains queued with open questions.

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
- If clarification is needed next, say that explicitly.
- If clarification just finished, explicitly resume the coordinator role and state the resulting task status.
