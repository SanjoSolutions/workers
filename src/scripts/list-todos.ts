#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { $ } from "zx";
import { loadSettings } from "../settings.js";
import {
  applyGitHubTokenFromSettings,
  resolveTaskTrackers,
  type ResolvedGitHubIssuesTaskTracker,
  type ResolvedGitTodoTaskTracker,
  type ResolvedTaskTracker,
} from "../task-tracker-settings.js";
import {
  listOpenGitHubIssues,
  partitionGitHubIssuesBySection,
  type GitHubIssue,
} from "../task-trackers.js";

type SectionFilter = "in-progress" | "ready" | "planned" | "all";
type Mode = "list" | "branches";

function parseDuration(duration: string): { gitSince: string; isoDate: string } {
  const match = duration.match(/^(\d+)(d|h|w)$/);
  if (!match) {
    throw new Error(`Invalid duration format: "${duration}". Expected formats like 7d, 24h, 2w.`);
  }
  const amount = parseInt(match[1], 10);
  const unit = match[2];

  const unitNames: Record<string, string> = { d: "days", h: "hours", w: "weeks" };
  const gitSince = `${amount} ${unitNames[unit]} ago`;

  const now = new Date();
  if (unit === "d") {
    now.setDate(now.getDate() - amount);
  } else if (unit === "h") {
    now.setHours(now.getHours() - amount);
  } else if (unit === "w") {
    now.setDate(now.getDate() - amount * 7);
  }
  const isoDate = now.toISOString();

  return { gitSince, isoDate };
}

async function getCompletedGitTodos(
  repoPath: string,
  filePath: string,
  gitSince: string,
): Promise<string[]> {
  const result = await $`git -C ${repoPath} log -p --since=${gitSince} -- ${filePath}`
    .quiet()
    .nothrow();
  if (result.exitCode !== 0 || !result.stdout) return [];

  const completed: string[] = [];
  for (const line of result.stdout.split("\n")) {
    if (/^-[^-]/.test(line)) {
      const content = line.slice(1);
      if (/^- /.test(content)) {
        completed.push(content);
      }
    }
  }

  return [...new Set(completed)];
}

function extractItemDependencies(item: string): string[] {
  const dependencies: string[] = [];
  for (const line of item.split("\n")) {
    const match = line.match(/^\s+- Depends on:\s+(.+?)\s*$/);
    if (match) dependencies.push(match[1]);
  }
  return dependencies;
}

function renderGitHubIssueItem(
  issue: { title: string; body: string },
  taskSpecItem?: string,
): string {
  if (taskSpecItem) {
    return taskSpecItem;
  }

  const bodyLines = issue.body
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line, index, lines) => {
      if (line !== "") {
        return true;
      }
      return index > 0 && index < lines.length - 1;
    });

  return [`- ${issue.title}`, ...bodyLines].join("\n").trim();
}

function extractItemSummary(item: string): string {
  return item.split("\n")[0].replace(/^- /, "").trim();
}

function parseArgs(argv: string[]): { section: SectionFilter; mode: Mode; completed: boolean; since: string } {
  let section: SectionFilter = "all";
  let mode: Mode = "list";
  let completed = false;
  let since = "7d";

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--in-progress") {
      section = "in-progress";
    } else if (arg === "--ready") {
      section = "ready";
    } else if (arg === "--planned") {
      section = "planned";
    } else if (arg === "--all") {
      section = "all";
    } else if (arg === "--branches") {
      mode = "branches";
    } else if (arg === "--completed") {
      completed = true;
    } else if (arg === "--since") {
      index += 1;
      const value = argv[index];
      if (!value) {
        console.error("--since requires a value (e.g. 7d, 24h, 2w)");
        process.exit(1);
      }
      since = value;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: list-todos [--in-progress | --ready | --planned | --all | --branches] [--completed [--since <duration>]]");
      console.log("Lists TODO items from all configured task trackers.");
      console.log("  --branches          Cross-reference worker branches with tracked TODOs.");
      console.log("  --completed         Show completed (removed) TODO items from history.");
      console.log("  --since <duration>  How far back to look for completed items (default: 7d).");
      console.log("                      Supported formats: 7d (days), 24h (hours), 2w (weeks).");
      process.exit(0);
    }
  }

  return { section, mode, completed, since };
}

const SECTION_HEADERS: Record<string, string> = {
  "in-progress": "## In progress",
  ready: "## Ready to be picked up",
  planned: "## Planned",
};

function extractSectionItems(
  content: string,
  sectionHeader: string,
): string[] {
  const lines = content.split(/\r?\n/);
  const headerIndex = lines.findIndex(
    (line) => line.trim() === sectionHeader,
  );
  if (headerIndex < 0) return [];

  const items: string[] = [];
  let current: string[] = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^##?\s+/.test(line)) break;
    if (/^- /.test(line)) {
      if (current.length > 0) items.push(current.join("\n"));
      current = [line];
    } else if (current.length > 0 && line.trim() !== "") {
      current.push(line);
    } else if (current.length > 0 && line.trim() === "") {
      items.push(current.join("\n"));
      current = [];
    }
  }
  if (current.length > 0) items.push(current.join("\n"));

  return items;
}

async function listGitTodoTracker(
  tracker: ResolvedGitTodoTaskTracker,
  section: SectionFilter,
  completed: boolean,
  since: string,
): Promise<void> {
  const todoPath = path.resolve(tracker.repo, tracker.file);
  let content: string;
  try {
    content = readFileSync(todoPath, "utf8");
  } catch {
    console.log(`  (could not read ${todoPath})`);
    return;
  }

  const inProgressItems = extractSectionItems(content, SECTION_HEADERS["in-progress"]);
  const readyItems = extractSectionItems(content, SECTION_HEADERS["ready"]);
  const activeSummaries = new Set(
    [...inProgressItems, ...readyItems].map((item) => item.split("\n")[0].replace(/^- /, "").trim()),
  );

  const sections =
    section === "all"
      ? (["in-progress", "ready", "planned"] as const)
      : [section];

  for (const sectionName of sections) {
    const header = SECTION_HEADERS[sectionName];
    const items = extractSectionItems(content, header);
    if (items.length === 0) continue;

    console.log(`  ${header}:`);
    for (const item of items) {
      const summary = item.split("\n")[0];
      console.log(`    ${summary}`);

      if (sectionName === "ready") {
        const dependencies = extractItemDependencies(item);
        const blockedBy = dependencies.filter((dep) => activeSummaries.has(dep));
        if (blockedBy.length > 0) {
          console.log(`      (blocked by: ${blockedBy.join(", ")})`);
        }
      }
    }
  }

  if (completed) {
    const { gitSince } = parseDuration(since);
    const completedItems = await getCompletedGitTodos(tracker.repo, tracker.file, gitSince);
    if (completedItems.length > 0) {
      console.log(`  ## Completed (since ${since}):`);
      for (const item of completedItems) {
        console.log(`    ${item}`);
      }
    }
  }
}

async function listGitHubIssuesTracker(
  tracker: ResolvedGitHubIssuesTaskTracker,
  section: SectionFilter,
  completed: boolean,
  since: string,
): Promise<void> {
  const sections =
    section === "all"
      ? (["in-progress", "ready", "planned"] as const)
      : [section];

  let openIssuesBySection: Record<string, GitHubIssue[]> = {};
  try {
    openIssuesBySection = partitionGitHubIssuesBySection(
      await listOpenGitHubIssues(tracker),
      tracker,
    );
  } catch {
    openIssuesBySection = {};
  }

  const activeTitles = new Set<string>();
  for (const sectionName of ["in-progress", "ready"] as const) {
    for (const issue of openIssuesBySection[sectionName] ?? []) {
      activeTitles.add(
        extractItemSummary(renderGitHubIssueItem(issue, issue.taskSpecItem)),
      );
    }
  }

  for (const sectionName of sections) {
    const issues = openIssuesBySection[sectionName];
    if (!issues || issues.length === 0) continue;

    const header = sectionName === "in-progress" ? "In progress" : sectionName === "ready" ? "Ready to be picked up" : "Planned";
    console.log(`  ## ${header}:`);
    for (const issue of issues) {
      const item = renderGitHubIssueItem(issue, issue.taskSpecItem);
      const summary = extractItemSummary(item);
      console.log(`    - ${summary} (#${issue.number})`);

      if (sectionName === "ready") {
        const dependencies = extractItemDependencies(item);
        const blockedBy = dependencies.filter((dep) => activeTitles.has(dep));
        if (blockedBy.length > 0) {
          console.log(`      (blocked by: ${blockedBy.join(", ")})`);
        }
      }
    }
  }

  if (completed) {
    const { isoDate } = parseDuration(since);
    const result =
      await $`gh issue list --repo ${tracker.repository} --state closed --limit 100 --json number,title,closedAt`
        .quiet()
        .nothrow();
    if (result.exitCode === 0) {
      const closedIssues = JSON.parse(result.stdout) as { number: number; title: string; closedAt: string }[];
      const recentlyClosed = closedIssues.filter((issue) => issue.closedAt >= isoDate);
      if (recentlyClosed.length > 0) {
        console.log(`  ## Completed (since ${since}):`);
        for (const issue of recentlyClosed) {
          console.log(`    - ${issue.title} (#${issue.number})`);
        }
      }
    }
  }
}

interface ParsedWorktree {
  path: string;
  head: string;
  branch: string | null;
}

function parseWorktreePorcelain(output: string): ParsedWorktree[] {
  const worktrees: ParsedWorktree[] = [];
  let current: Partial<ParsedWorktree> = {};

  for (const line of output.split("\n")) {
    if (line === "") {
      if (current.path) {
        worktrees.push({
          path: current.path,
          head: current.head ?? "",
          branch: current.branch ?? null,
        });
      }
      current = {};
      continue;
    }

    if (line.startsWith("worktree ")) {
      current.path = line.slice("worktree ".length).trim();
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
    } else if (line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length).trim();
    }
  }

  if (current.path) {
    worktrees.push({
      path: current.path,
      head: current.head ?? "",
      branch: current.branch ?? null,
    });
  }

  return worktrees;
}

async function collectTrackerInProgressSummaries(
  trackers: ResolvedTaskTracker[],
): Promise<Set<string>> {
  const summaries = new Set<string>();

  for (const tracker of trackers) {
    if (tracker.kind === "git-todo") {
      const todoPath = path.resolve(tracker.repo, tracker.file);
      try {
        const content = readFileSync(todoPath, "utf8");
        const items = extractSectionItems(content, SECTION_HEADERS["in-progress"]);
        for (const item of items) {
          summaries.add(item.split("\n")[0].replace(/^- /, "").trim());
        }
      } catch {
        // skip unreadable trackers
      }
    } else {
      try {
        const openIssues = await listOpenGitHubIssues(tracker);
        const inProgressIssues = partitionGitHubIssuesBySection(openIssues, tracker)["in-progress"];
        for (const issue of inProgressIssues) {
          summaries.add(
            extractItemSummary(renderGitHubIssueItem(issue, issue.taskSpecItem)),
          );
        }
      } catch {
        // skip unreadable trackers
      }
    }
  }

  return summaries;
}

interface BranchStatus {
  branch: string;
  worktreePath: string;
  summary: string | null;
  status: "finished" | "in-progress" | "unknown";
}

async function getBranchStatuses(
  projectRepo: string,
  trackerInProgressSummaries: Set<string>,
): Promise<BranchStatus[]> {
  const result =
    await $`git -C ${projectRepo} worktree list --porcelain`.quiet().nothrow();
  if (result.exitCode !== 0) {
    return [];
  }

  const worktrees = parseWorktreePorcelain(result.stdout);
  const workWorktrees = worktrees.filter(
    (wt) => wt.branch !== null && wt.branch.startsWith("work/"),
  );

  const statuses: BranchStatus[] = [];

  for (const wt of workWorktrees) {
    const localTodoPath = path.join(wt.path, "TODO.md");
    let localSummary: string | null = null;

    if (existsSync(localTodoPath)) {
      try {
        const localContent = readFileSync(localTodoPath, "utf8");
        const localInProgress = extractSectionItems(localContent, SECTION_HEADERS["in-progress"]);
        if (localInProgress.length > 0) {
          localSummary = localInProgress[0].split("\n")[0].replace(/^- /, "").trim();
        }
      } catch {
        // ignore read errors
      }
    }

    let status: "finished" | "in-progress" | "unknown";
    if (localSummary === null) {
      status = "unknown";
    } else if (trackerInProgressSummaries.has(localSummary)) {
      status = "in-progress";
    } else {
      status = "finished";
    }

    statuses.push({
      branch: wt.branch!,
      worktreePath: wt.path,
      summary: localSummary,
      status,
    });
  }

  return statuses;
}

async function listBranches(
  trackers: Record<string, ResolvedTaskTracker>,
  projectRepos: string[],
): Promise<void> {
  const trackerList = Object.values(trackers);

  if (trackerList.length === 0 && projectRepos.length === 0) {
    console.log("No task trackers or projects configured.");
    return;
  }

  const trackerInProgressSummaries = await collectTrackerInProgressSummaries(trackerList);

  const allRepos = new Set<string>(projectRepos);
  for (const tracker of trackerList) {
    if (tracker.kind === "git-todo") {
      allRepos.add(path.resolve(tracker.repo));
    }
  }

  let anyBranches = false;

  for (const projectRepo of allRepos) {
    const statuses = await getBranchStatuses(projectRepo, trackerInProgressSummaries);
    if (statuses.length === 0) continue;

    anyBranches = true;
    console.log(`[${path.basename(projectRepo)}] ${projectRepo}`);

    const finished = statuses.filter((status) => status.status === "finished");
    const inProgress = statuses.filter((status) => status.status === "in-progress");
    const unknown = statuses.filter((status) => status.status === "unknown");

    if (finished.length > 0) {
      console.log("  Finished branches (ready to merge):");
      for (const item of finished) {
        console.log(`    ${item.branch}`);
        if (item.summary) {
          console.log(`      Task: ${item.summary}`);
        }
      }
    }

    if (inProgress.length > 0) {
      console.log("  In-progress branches:");
      for (const item of inProgress) {
        console.log(`    ${item.branch}`);
        if (item.summary) {
          console.log(`      Task: ${item.summary}`);
        }
      }
    }

    if (unknown.length > 0) {
      console.log("  Unknown branches (no local TODO found):");
      for (const item of unknown) {
        console.log(`    ${item.branch}`);
      }
    }

    console.log();
  }

  if (!anyBranches) {
    console.log("No worker branches found.");
  }
}

export async function runListTodosCli(argv = process.argv): Promise<void> {
  const args = parseArgs(argv);
  const settings = await loadSettings();
  await applyGitHubTokenFromSettings(settings);
  const { trackers } = resolveTaskTrackers(settings);

  if (args.mode === "branches") {
    const projectRepos = settings.projects.map((project) => path.resolve(project.repo));
    await listBranches(trackers, projectRepos);
    return;
  }

  const trackerList = Object.values(trackers);
  if (trackerList.length === 0) {
    console.log("No task trackers configured.");
    return;
  }

  for (const tracker of trackerList) {
    console.log(`[${tracker.name}] (${tracker.kind})`);
    if (tracker.kind === "git-todo") {
      await listGitTodoTracker(tracker, args.section, args.completed, args.since);
    } else {
      await listGitHubIssuesTracker(tracker, args.section, args.completed, args.since);
    }
    console.log();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runListTodosCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
