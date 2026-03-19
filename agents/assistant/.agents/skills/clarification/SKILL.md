---
name: clarification
description: "Clarify queued work into autonomous worker tasks for the assistant. Supports both Codex CLI and Claude Code CLI."
---

# Clarification Skill

Clarify tasks from `TODO.md` -> `## Planned`, then move fully clarified items to `## Ready to be picked up` so the workers workflow can execute them without follow-up questions.

This assistant-local capability is intended for a shared workers repo that may track work across
multiple projects. For each TODO, inspect the relevant project repo or repos before asking
questions.

## Scope

- Only process items in `## Planned`.
- Skip all other sections.
- Once an item is fully clarified, it belongs under `## Ready to be picked up`, not `## Planned`.

## Runtime Behavior

Use the workflow that matches the current agent environment:

- If the current environment supports a planning-only mode where file edits are not allowed, use a two-stage flow:
  1. Clarify and prepare a write-ready `TODO_UPDATE_DRAFT`.
  2. Apply that draft later in a mode that can edit files.
- If the current environment can edit files directly, clarify first and then update `TODO.md` in the same run.

When you are in a non-editing mode:

- If no prepared draft exists yet, ask the user to switch into the planning flow for this skill and continue clarification there.
- If a prepared draft already exists in recent context, apply it once you are back in an editing-capable mode.

## Process

### 1. Read TODO.md and the relevant project code

- Read `TODO.md` and collect all items from `## Planned`.
- If there are no items, report that nothing needs clarification and stop.
- Read the relevant project repo areas before asking questions. Do not ask for information you can discover from the code or existing task context.

### 2. Classify each item

Classify each TODO as exactly one of:

- `Type: Bug fix`
- `Type: Development task`
- `Type: New project`

### 3. Analyze overlap and dependencies

For each item, identify likely touched files and check:

- Same-file overlap
- Same-module overlap
- True task dependencies

If overlapping tasks should remain separate, add:

`- Conflict risk: <file path(s)> also modified by "<other task summary>"`

If one task truly depends on another, add:

`- Depends on: "<exact summary of prerequisite task>"`

### 4. Identify clarification needs

For bug fixes, clarify:

- reproduction conditions
- expected behavior
- affected surface
- environment factors

For development tasks, clarify:

- inputs and outputs
- scope boundaries
- edge cases
- acceptance criteria

For new-project tasks, clarify:

- target repo path
- bootstrap expectations
- required remote, if any
- initial deliverable and acceptance criteria

Ask only questions that materially change implementation or validation. Skip questions about code placement, naming, or implementation details the agent can decide.

### 5. Ask questions

- Batch questions where practical, up to 4 per round.
- Keep one TODO item in focus at a time.
- For items that need no clarification, state that and continue.

### 6. Build clarified task entries

For each fully clarified item, use this structure:

```markdown
- Clear, imperative summary of what to do
  - Type: Development task | Bug fix | New project
  - Repo: <target repo path>
  - Agent: Claude | Codex | Gemini
  - Reasoning: low | medium | high | xhigh
  - Decisions:
    - Q: <question>
    - A: <answer>
  - Context: <useful codebase fact>
  - Scope: <what is included>
  - Out of scope: <what is excluded>
  - Depends on: "<summary of prerequisite task>"
  - Conflict risk: <file path(s)> also modified by "<other task summary>"
  - Acceptance: <testable condition>
```

Format rules:

- `Type` is required and must be exactly `Development task`, `Bug fix`, or `New project`.
- `Repo` is required for all worker-ready tasks.
- Use `Repo: none` for tasks that should run outside any project repo.
- `Agent` is optional and must be exactly `Claude`, `Codex`, or `Gemini` when present.
- `Reasoning` is optional. Use it only when a Codex task needs a non-default reasoning level; omit
  it otherwise because workers defaults Codex reasoning to `high`.
- `Decisions` is optional and should use `Q:` / `A:` pairs.
- `Context` is optional and should only include non-obvious repo facts.
- `Scope` and `Out of scope` are optional.
- `Depends on` is only for real prerequisites.
- `Conflict risk` is only for overlapping tasks kept separate.
- At least one `Acceptance` line is required, and every acceptance criterion must be testable.

### 7. Apply clarified tasks

If you can edit files now:

- Remove fully clarified items from `## Planned`.
- Insert them under `## Ready to be picked up`.
- Keep unresolved items in `## Planned`.
- Re-read `TODO.md` and confirm the section state.

If you cannot edit files now:

- Do not edit `TODO.md`.
- Produce a write-ready handoff block in this format:

```markdown
TODO_UPDATE_DRAFT
ready_items:
<markdown list items>

remaining_planned_items:
<markdown list items or empty>

notes:
<optional notes>
```

- Output only that block.

## Acceptance Examples

- Good: `Acceptance: pnpm test src/lib/example.test.ts passes.`
- Good: `Acceptance: Saving settings persists after reload.`
- Bad: `Acceptance: It works correctly.`
- Bad: `Acceptance: Code is clean.`

## Output Rules

- Keep clarification concise and implementation-focused.
- Rewrite vague TODO summaries into clear imperative instructions.
- Do not commit changes.
