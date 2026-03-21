#!/usr/bin/env node

import { realpathSync } from "fs";
import { pathToFileURL } from "url";
import { runInitTaskTrackerCli } from "../init-task-tracker-cli.js";
import { runAddTodoCli } from "../scripts/add-todo.js";
import { runListTodosCli } from "../scripts/list-todos.js";
import { runAssistantCli } from "./assistant.js";
import { runWorkerCli } from "./worker.js";

type CommandHandler = (argv: string[]) => Promise<void>;

interface OrchestrateHandlers {
  add: CommandHandler;
  assistant: CommandHandler;
  init: CommandHandler;
  list: CommandHandler;
  worker: CommandHandler;
}

interface RunOrchestrateOptions {
  handlers?: OrchestrateHandlers;
  stderr?: (text: string) => void;
  stdout?: (text: string) => void;
}

const DEFAULT_HANDLERS: OrchestrateHandlers = {
  add: runAddTodoCli,
  assistant: runAssistantCli,
  init: runInitTaskTrackerCli,
  list: runListTodosCli,
  worker: runWorkerCli,
};

function printUsage(write: (text: string) => void): void {
  write(`Usage: o <command> [arguments] [options]

Commands:
  assistant          Launch the assistant session
  worker             Launch a worker
  init               Initialize the shared task tracker
  add                Add work to the configured task tracker
  list               List task tracker items and worker branches
  status             Alias for "list"

Run "o <command> --help" for command-specific options.
`);
}

export async function runOrchestrateCli(
  argv = process.argv,
  options?: RunOrchestrateOptions,
): Promise<number> {
  const stdout = options?.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options?.stderr ?? ((text: string) => process.stderr.write(text));
  const handlers = options?.handlers ?? DEFAULT_HANDLERS;
  const command = argv[2];
  const args = argv.slice(3);

  if (!command || command === "-h" || command === "--help" || command === "help") {
    printUsage(stdout);
    return 0;
  }

  if (command === "assistant") {
    await handlers.assistant(["node", "assistant", ...args]);
    return 0;
  }

  if (command === "worker") {
    await handlers.worker(["node", "worker", ...args]);
    return 0;
  }

  if (command === "init") {
    await handlers.init(["node", "init", ...args]);
    return 0;
  }

  if (command === "add") {
    await handlers.add(["node", "add", ...args]);
    return 0;
  }

  if (command === "list" || command === "status") {
    await handlers.list(["node", "list", ...args]);
    return 0;
  }

  stderr(`Unknown command "${command}".\n\n`);
  printUsage(stderr);
  return 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runOrchestrateCli()
    .then((exitCode) => {
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
