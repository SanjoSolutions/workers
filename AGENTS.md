# AGENTS.md

Repository-specific instructions for this repository.

## Auto-commit

- After completing a task and verifying the result, auto-commit by default unless the user explicitly says not to.
- Keep auto-generated commits focused on the work completed in that task.
- Do not auto-push unless the user explicitly asks for it.

## Workflow

- `SPEC.md` is the high-level natural language specification for this repository. Update it whenever requirements change or new ones are added.
- When a new requirement conflicts with an existing requirement in `SPEC.md`, do not silently choose one. Surface the conflict to the user and let them decide.
- The direct user-facing Codex session should automatically follow `.agents/skills/coordinator/SKILL.md`.
