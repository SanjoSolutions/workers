> [!NOTE]
> This project is still in early development.

# Workers

A human-first process that supports spontaneity.

## Features

* Assistant - Workers architecture
  * One assistant which is the direct communication partner for the human.
    It delegates bigger tasks to workers for high throughput.
  * Each worker works on one task at a time.
* Multi-project support.
* Supports codex, claude, gemini and pi CLIs.
* Supported task trackers (can be extended):
  * GitHub Issues
  * TODO.md: A lightweight task management system.
* SPEC.md: A standard for a high-level project spec.

## How to

__Prerequisites:__

* Node.js

```bash
npm install -g @sanjo/workers
```

Just run `assistant` and start telling it what you'd like to be built.

In different terminals, start workers (with `worker`). They will pick up tasks, as they become available. You can also specify the agent CLI. I.e. `worker --cli claude` (or codex or gemini).
