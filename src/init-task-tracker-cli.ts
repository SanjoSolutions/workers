import path from "path";
import { initGitTodoRepo, updateShellConfig } from "./init-task-tracker.js";

interface ParsedInitArgs {
  repoDir: string;
  shellConfigPath: string | undefined;
  trackerType: "git-todo" | "github-issues";
}

function printUsage(): void {
  console.log(`Usage: o init [repo-dir] [options]

Initialize the shared task tracker repository.

Arguments:
  repo-dir             Target directory for the shared tracker repository
                       (defaults to the current directory)

Options:
  --tracker <type>     Task tracker type to initialize (default: git-todo)
  --shell-config <path>
                       Shell config file to update with WORKERS_TODO_REPO
  -h, --help           Print this help message and exit`);
}

function parseArgs(argv: string[]): ParsedInitArgs {
  let repoDir = process.cwd();
  let shellConfigPath: string | undefined;
  let trackerType: "git-todo" | "github-issues" = "git-todo";

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--shell-config") {
      const value = argv[index + 1]?.trim();
      if (!value) {
        throw new Error("--shell-config requires a path.");
      }
      shellConfigPath = value;
      index += 1;
      continue;
    }

    if (arg === "--tracker") {
      const value = argv[index + 1]?.trim();
      if (value !== "git-todo" && value !== "github-issues") {
        throw new Error("--tracker must be one of: git-todo, github-issues");
      }
      trackerType = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    repoDir = path.resolve(arg);
  }

  return {
    repoDir,
    shellConfigPath,
    trackerType,
  };
}

export async function runInitTaskTrackerCli(argv = process.argv): Promise<void> {
  const args = parseArgs(argv);

  if (args.trackerType !== "git-todo") {
    throw new Error(
      "GitHub Issues setup is not yet supported interactively. Configure it manually in settings.json.",
    );
  }

  await initGitTodoRepo(args.repoDir);
  updateShellConfig(args.repoDir, args.shellConfigPath);
  process.env.WORKERS_TODO_REPO = args.repoDir;
  process.stdout.write(`Task tracker initialized. WORKERS_TODO_REPO=${args.repoDir}\n`);
}
