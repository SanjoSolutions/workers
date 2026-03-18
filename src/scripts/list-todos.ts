#!/usr/bin/env node

import { readFileSync } from "fs";
import path from "path";
import { $ } from "zx";
import { loadSettings } from "../settings.js";
import {
  resolveTaskTrackers,
  type ResolvedGitTodoTaskTracker,
  type ResolvedGitHubIssuesTaskTracker,
} from "../task-tracker-settings.js";

type SectionFilter = "in-progress" | "ready" | "planned" | "all";

function extractItemDependencies(item: string): string[] {
  const dependencies: string[] = [];
  for (const line of item.split("\n")) {
    const match = line.match(/^\s+- Depends on:\s+(.+?)\s*$/);
    if (match) dependencies.push(match[1]);
  }
  return dependencies;
}

function parseArgs(argv: string[]): { section: SectionFilter } {
  let section: SectionFilter = "all";

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
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: list-todos [--in-progress | --ready | --planned | --all]");
      console.log("Lists TODO items from all configured task trackers.");
      process.exit(0);
    }
  }

  return { section };
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
}

async function listGitHubIssuesTracker(
  tracker: ResolvedGitHubIssuesTaskTracker,
  section: SectionFilter,
): Promise<void> {
  const labelMap: Record<string, string> = {
    "in-progress": tracker.labels.inProgress,
    ready: tracker.labels.ready,
    planned: tracker.labels.planned,
  };

  const sections =
    section === "all"
      ? (["in-progress", "ready", "planned"] as const)
      : [section];

  const openIssuesBySection: Record<string, { number: number; title: string; body: string }[]> = {};
  for (const sectionName of sections) {
    const label = labelMap[sectionName];
    const result =
      await $`gh issue list --repo ${tracker.repository} --state open --label ${label} --limit 100 --json number,title,body`
        .quiet()
        .nothrow();
    if (result.exitCode !== 0) {
      openIssuesBySection[sectionName] = [];
    } else {
      openIssuesBySection[sectionName] = JSON.parse(result.stdout) as { number: number; title: string; body: string }[];
    }
  }

  const activeTitles = new Set<string>();
  for (const sectionName of ["in-progress", "ready"] as const) {
    for (const issue of openIssuesBySection[sectionName] ?? []) {
      activeTitles.add(issue.title);
    }
  }

  for (const sectionName of sections) {
    const issues = openIssuesBySection[sectionName];
    if (!issues || issues.length === 0) continue;

    const header = sectionName === "in-progress" ? "In progress" : sectionName === "ready" ? "Ready to be picked up" : "Planned";
    console.log(`  ## ${header}:`);
    for (const issue of issues) {
      console.log(`    - ${issue.title} (#${issue.number})`);

      if (sectionName === "ready") {
        const dependencies = extractItemDependencies(`- ${issue.title}\n${issue.body}`);
        const blockedBy = dependencies.filter((dep) => activeTitles.has(dep));
        if (blockedBy.length > 0) {
          console.log(`      (blocked by: ${blockedBy.join(", ")})`);
        }
      }
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const settings = await loadSettings();
  const { trackers } = resolveTaskTrackers(settings);

  const trackerList = Object.values(trackers);
  if (trackerList.length === 0) {
    console.log("No task trackers configured.");
    return;
  }

  for (const tracker of trackerList) {
    console.log(`[${tracker.name}] (${tracker.kind})`);
    if (tracker.kind === "git-todo") {
      await listGitTodoTracker(tracker, args.section);
    } else {
      await listGitHubIssuesTracker(tracker, args.section);
    }
    console.log();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
