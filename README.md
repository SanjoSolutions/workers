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

__Prerequisites:__

* Node.js

```bash
npm install -g @sanjo/workers
```

Just run `assistant` and start telling it what you'd like to be built.

In different terminals, start workers (with `worker`). They will pick up tasks, as they become available. You can also specify the agent CLI. I.e. `worker --cli claude` (or codex or gemini).
