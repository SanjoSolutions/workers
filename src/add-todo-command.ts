import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { insertIntoSection, type TodoSection } from "./add-todo.js";
import { withTodoLock } from "./claim-todo.js";
import { extractTodoField } from "./agent-prompt.js";
import {
  hasTaskTracker,
  loadSettings,
  persistProjectSettings,
  type WorkersSettings,
} from "./settings.js";
import {
  applyGitHubTokenFromSettings,
  resolveTaskTrackerForRepo,
  type ResolvedTaskTracker,
} from "./task-tracker-settings.js";
import {
  commitAndPushTodoRepo,
  createGitHubIssueTask,
  fastForwardRepo,
} from "./task-trackers.js";

export interface AddTodoCommandInput {
  section: TodoSection;
  text: string;
  issueNumber: number | undefined;
  cwd: string;
}

interface AddTodoCommandDependencies {
  loadSettings: () => Promise<WorkersSettings>;
  applyGitHubTokenFromSettings: (settings: WorkersSettings) => Promise<void>;
  extractTodoField: (text: string, field: string) => string | undefined;
  persistProjectSettings: (updates: Array<{ repo: string }>) => boolean;
  hasTaskTracker: (settings: WorkersSettings) => boolean;
  promptAndInitTaskTracker: (cwd: string) => Promise<void>;
  resolveTaskTrackerForRepo: (
    repoPath: string,
    settings: WorkersSettings,
  ) => ResolvedTaskTracker;
  fastForwardRepo: (repoRoot: string) => Promise<boolean>;
  withTodoLock: <T>(todoPath: string, callback: () => Promise<T>) => Promise<T>;
  readFile: (filePath: string) => string;
  writeFile: (filePath: string, content: string) => void;
  commitAndPushTodoRepo: (
    repoRoot: string,
    todoRelativePath: string,
    message: string,
  ) => Promise<boolean>;
  createGitHubIssueTask: typeof createGitHubIssueTask;
}

const defaultDependencies: AddTodoCommandDependencies = {
  loadSettings,
  applyGitHubTokenFromSettings,
  extractTodoField,
  persistProjectSettings,
  hasTaskTracker,
  promptAndInitTaskTracker: async (cwd: string) => {
    const { promptAndInitTaskTracker } = await import("./init-task-tracker.js");
    await promptAndInitTaskTracker(cwd);
  },
  resolveTaskTrackerForRepo,
  fastForwardRepo,
  withTodoLock,
  readFile: (filePath: string) => readFileSync(filePath, "utf8"),
  writeFile: (filePath: string, content: string) => writeFileSync(filePath, content, "utf8"),
  commitAndPushTodoRepo,
  createGitHubIssueTask,
};

export function normalizeTrackerItem(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""));

  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  if (lines.length === 0) {
    throw new Error("Item text is required.");
  }

  if (!lines[0].startsWith("- ")) {
    lines[0] = `- ${lines[0]}`;
  }

  return lines;
}

export async function addTodoToConfiguredTracker(
  input: AddTodoCommandInput,
  dependencies: AddTodoCommandDependencies = defaultDependencies,
): Promise<string> {
  let settings = await dependencies.loadSettings();
  await dependencies.applyGitHubTokenFromSettings(settings);

  const repoField = dependencies.extractTodoField(input.text, "Repo");
  if (repoField && repoField.toLowerCase() !== "none") {
    dependencies.persistProjectSettings([
      {
        repo: path.resolve(repoField),
      },
    ]);
  }

  const targetRepo = repoField && repoField.toLowerCase() !== "none"
    ? path.resolve(repoField)
    : input.cwd;

  if (!dependencies.hasTaskTracker(settings)) {
    await dependencies.promptAndInitTaskTracker(input.cwd);
    settings = await dependencies.loadSettings();
    await dependencies.applyGitHubTokenFromSettings(settings);
  }

  const tracker = dependencies.resolveTaskTrackerForRepo(targetRepo, settings);
  const itemLines = normalizeTrackerItem(input.text);

  if (tracker.kind === "github-issues") {
    const issueUrl = await dependencies.createGitHubIssueTask(
      tracker,
      input.section,
      itemLines,
      input.issueNumber,
    );
    const verb = input.issueNumber !== undefined ? "Updated" : "Added";
    return `${verb} item in ${input.section} in ${tracker.repository} as GitHub issue ${issueUrl} (task tracker: ${tracker.name})`;
  }

  const todoPath = path.resolve(tracker.repo, tracker.file);

  await dependencies.fastForwardRepo(tracker.repo);

  const pushed = await dependencies.withTodoLock(todoPath, async () => {
    const original = dependencies.readFile(todoPath);
    const nextContent = insertIntoSection(original, itemLines, input.section);
    dependencies.writeFile(todoPath, nextContent);

    const summary = itemLines[0].replace(/^- /, "");
    return dependencies.commitAndPushTodoRepo(
      tracker.repo,
      tracker.file,
      `Add TODO: ${summary}`,
    );
  });

  return `Added item to ${input.section} in ${todoPath} (task tracker: ${tracker.name})${pushed ? "" : " (push failed)"}`;
}

export const normalizeTodoItem = normalizeTrackerItem;
