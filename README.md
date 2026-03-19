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

Use the orchestration command:

```bash
o assistant
```

Tell the assistant what you want built. When you mention a project path for the first time, workers will register it automatically from the queued task metadata.

In different terminals, start workers with `o worker`. They will pick up tasks as they become available. You can also specify the agent CLI, for example `o worker --cli claude` or `o worker --cli pi`.

Useful subcommands:

* `o init [path]` initializes a shared TODO tracker repository.
* `o add [text]` adds work to the configured tracker.
* `o status` lists queued work, in-progress work, and worker branches.

The legacy `assistant` and `worker` commands still work, but `o` is the main interface.
